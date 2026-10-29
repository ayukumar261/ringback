import { Effect, Either, Layer, Schedule } from "effect";
import { ElevenLabsClient } from "../clients/elevenlabs.js";
import { MongoClient, type ExpenseDoc } from "../clients/mongo.js";
import { TwilioClient } from "../clients/twilio.js";
import { decimal, dollarsToCents, negate } from "../expenses/money.js";

// A claim hides an expense this long, so a crashed collector's work comes back.
const CLAIM_MS = 90_000;

const ENDED_CALL = ["completed", "canceled", "failed", "busy", "no-answer"];
const ENDED_CONVERSATION = ["done", "failed"];

// retryAt backs off from 30 seconds to at most an hour.
const retryAt = (attempts: number, now: Date) =>
  new Date(
    now.getTime() + Math.min(3_600_000, 15_000 * 2 ** Math.min(attempts, 8)),
  );

// price fetches an expense's final amount, or null while the provider is still pricing it.
const price = (expense: ExpenseDoc) =>
  Effect.gen(function* () {
    if (expense.provider === "twilio") {
      const twilio = yield* TwilioClient;
      const call = yield* twilio.getCall(expense.providerReference);
      if (
        !ENDED_CALL.includes(call.status) ||
        call.price === null ||
        call.price_unit === null
      )
        return null;
      return {
        amountCents: dollarsToCents(negate(call.price)),
        currency: call.price_unit.toLowerCase(),
      };
    }
    const elevenlabs = yield* ElevenLabsClient;
    const conversation = yield* elevenlabs.getConversation(
      expense.providerReference,
    );
    const dollars = conversation.metadata.cost_fiat;
    if (!ENDED_CONVERSATION.includes(conversation.status) || dollars === null)
      return null;
    return { amountCents: dollarsToCents(String(dollars)), currency: "usd" };
  });

// collectExpense prices the next due expense and reports whether there was one.
export const collectExpense = Effect.gen(function* () {
  const mongo = yield* MongoClient;
  const now = new Date();
  const expense = yield* Effect.tryPromise(() =>
    mongo.expenses.findOneAndUpdate(
      { "collection.nextAttemptAt": { $lte: now } },
      {
        $set: {
          "collection.nextAttemptAt": new Date(now.getTime() + CLAIM_MS),
        },
        $inc: { "collection.attempts": 1 },
      },
      { sort: { "collection.nextAttemptAt": 1 }, returnDocument: "after" },
    ),
  );
  if (!expense?.collection) return false;
  const result = yield* price(expense).pipe(Effect.either);
  const amount = Either.getOrNull(result);
  if (amount) {
    yield* Effect.tryPromise(() =>
      mongo.expenses.updateOne(
        { _id: expense._id },
        {
          $set: {
            amountCents: decimal(amount.amountCents),
            currency: amount.currency,
            status: "reported",
            updatedAt: now,
          },
          $unset: { collection: "" },
        },
      ),
    );
    return true;
  }
  const retry = {
    "collection.nextAttemptAt": retryAt(expense.collection.attempts, now),
    "collection.lastError": Either.isLeft(result)
      ? result.left.code
      : "pricing_pending",
    updatedAt: now,
  };
  yield* Effect.tryPromise(() =>
    mongo.expenses.updateOne({ _id: expense._id }, { $set: retry }),
  );
  return true;
});

// ExpenseCollectorLive prices due expenses every 5 seconds, up to 16 at a time.
export const ExpenseCollectorLive = Layer.scopedDiscard(
  collectExpense.pipe(
    Effect.repeat({ while: (due) => due, times: 15 }),
    Effect.catchAllCause((cause) =>
      Effect.logWarning("expenses: collection failed; will retry", cause),
    ),
    Effect.repeat(Schedule.spaced("5 seconds")),
    Effect.forkScoped,
  ),
);
