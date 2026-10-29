import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import type { ExpenseDoc, MongoClient } from "../clients/mongo.js";
import type { Environment } from "../environment.js";
import type { WorkerEvent } from "../events/index.js";
import { decimal } from "./money.js";

// ExpenseAttribution links a charge to the call request it was for.
export type ExpenseAttribution = Pick<ExpenseDoc, "requestId" | "room">;

// Twilio's published Line Type Intelligence rate: $0.008 per request.
const LOOKUP_CENTS = "0.8";

// Providers price a call after it ends, so the first fetch waits briefly.
const FIRST_ATTEMPT_MS = 15_000;

// recordLookup saves one billed Lookup at the published rate, logging instead of failing.
export const recordLookup = (
  mongo: MongoClient,
  environment: Environment,
  attribution: ExpenseAttribution,
) =>
  Effect.tryPromise(() => {
    const now = new Date();
    const reference = randomUUID();
    return mongo.expenses.insertOne({
      _id: `lookup_api:${reference}`,
      environment,
      ...(attribution.requestId && { requestId: attribution.requestId }),
      ...(attribution.room && { room: attribution.room }),
      provider: "twilio",
      type: "lookup_api",
      providerReference: reference,
      amountCents: decimal(LOOKUP_CENTS),
      currency: "usd",
      status: "estimated",
      incurredAt: now,
      createdAt: now,
      updatedAt: now,
    });
  }).pipe(
    Effect.asVoid,
    Effect.catchAllCause((cause) =>
      Effect.logWarning("expenses: Lookup not recorded", cause),
    ),
  );

// queue saves a pending charge for the collector once; a replay changes nothing.
const queue = (
  mongo: MongoClient,
  environment: Environment,
  room: string,
  charge: Pick<ExpenseDoc, "provider" | "type" | "providerReference">,
  incurredAt: Date,
) =>
  Effect.gen(function* () {
    const request = yield* Effect.tryPromise(() =>
      mongo.requests.findOne({ room }),
    );
    const now = new Date();
    yield* Effect.tryPromise(() =>
      mongo.expenses.updateOne(
        { _id: `${charge.type}:${charge.providerReference}` },
        {
          $setOnInsert: {
            environment: request?.environment ?? environment,
            ...(request && { requestId: request._id }),
            room,
            ...charge,
            amountCents: null,
            currency: null,
            status: "pending",
            incurredAt,
            createdAt: now,
            updatedAt: now,
            collection: {
              attempts: 0,
              nextAttemptAt: new Date(now.getTime() + FIRST_ATTEMPT_MS),
            },
          },
        },
        { upsert: true },
      ),
    );
  });

// captureExpense queues a call's Twilio and ElevenLabs charges, safe to repeat.
export const captureExpense = (
  mongo: MongoClient,
  environment: Environment,
  event: WorkerEvent,
) =>
  Effect.gen(function* () {
    switch (event.event) {
      case "call.sip":
        return yield* queue(
          mongo,
          environment,
          event.room,
          {
            provider: "twilio",
            type: "elastic_sip_trunking",
            providerReference: event.call_sid,
          },
          new Date(event.at),
        );
      case "call.started":
        if (!event.conversation_id)
          return yield* Effect.logWarning(
            "expenses: no conversation ID; ElevenLabs cost isn't tracked",
          ).pipe(Effect.annotateLogs({ room: event.room }));
        return yield* queue(
          mongo,
          environment,
          event.room,
          {
            provider: "elevenlabs",
            type: "elevenlabs_agent",
            providerReference: event.conversation_id,
          },
          new Date(event.started_at),
        );
      case "call.ended":
        yield* Effect.tryPromise(() =>
          mongo.expenses.updateMany(
            { room: event.room, collection: { $exists: true } },
            { $set: { "collection.nextAttemptAt": new Date() } },
          ),
        );
        return;
      case "call.turn":
        return;
    }
  });
