import { Effect, Layer, Schedule } from "effect";
import { MongoClient } from "../clients/mongo.js";
import { RedisClient } from "../clients/redis.js";
import { LiveKitClient, LiveKitError } from "../clients/livekit.js";
import { callDialedEmail, sendEmail } from "../emails/calls.js";
import { PaymentConfig } from "../handlers/payments/config.js";
import {
  PaymentError,
  logPaymentFailure,
} from "../handlers/payments/errors.js";
import {
  normalizeCheckoutEmail,
  requestSnapshotHash,
} from "../handlers/payments/schema.js";
import { Preflight } from "../preflight/preflight.js";
import { FreeCallLimitError, PreflightError } from "../preflight/errors.js";
import { CallLimit, makeFreeCallLimit } from "../preflight/limit.js";

// dispatchCall claims the oldest paid call and dials it once, since a failed dial may have gone through.
export const dispatchCall = Effect.gen(function* () {
  const mongo = yield* MongoClient;
  const settings = yield* PaymentConfig;
  const dialer = yield* LiveKitClient;
  const limit = yield* CallLimit;
  const environment = settings.environment;
  const stale = yield* Effect.tryPromise(() =>
    mongo.requests.updateMany(
      {
        status: "dialing",
        environment,
        claimedAt: { $lt: new Date(Date.now() - 120_000) },
      },
      { $set: { status: "failed", error: "interrupted" } },
    ),
  );
  if (stale.modifiedCount) {
    yield* logPaymentFailure("dispatch", "interrupted").pipe(
      Effect.annotateLogs({ count: stale.modifiedCount }),
    );
  }
  const record = yield* Effect.tryPromise(() =>
    mongo.requests.findOneAndUpdate(
      { status: "paid", environment },
      { $set: { status: "dialing", claimedAt: new Date() } },
      { sort: { createdAt: 1 }, returnDocument: "after" },
    ),
  );
  if (!record) return false;
  let releaseDestination: Effect.Effect<void> = Effect.void;
  let releaseFreeCall: Effect.Effect<void> = Effect.void;
  let completeFreeCall: Effect.Effect<void, FreeCallLimitError> = Effect.void;
  const recordError = (code: string) =>
    Effect.gen(function* () {
      yield* releaseDestination;
      yield* releaseFreeCall;
      yield* logPaymentFailure("dispatch", code);
      yield* Effect.tryPromise(() =>
        mongo.requests.updateOne(
          { _id: record._id, status: "dialing" },
          { $set: { status: "failed", error: code } },
        ),
      );
    });
  yield* Effect.gen(function* () {
    const purchase = record.purchaseId
      ? yield* Effect.tryPromise(() =>
          mongo.purchases.findOne({ _id: record.purchaseId }),
        )
      : null;
    if (
      !purchase ||
      purchase.requestId !== record._id ||
      purchase.checkoutSessionId !== record.checkout?.id ||
      purchase.stripeAccountId !== record.checkout?.accountId ||
      purchase.livemode !== record.checkout?.livemode ||
      record.environment !== environment ||
      purchase.livemode !== (environment === "production") ||
      // Older purchases predate discounts and stored only the full-price total.
      (purchase.amountSubtotal ?? purchase.amountTotal) !== record.amount ||
      !Number.isSafeInteger(purchase.amountTotal) ||
      purchase.amountTotal < 0 ||
      purchase.amountTotal > record.amount ||
      purchase.currency !== record.currency ||
      requestSnapshotHash(record) !== record.requestSnapshotHash
    )
      return yield* new PaymentError({ code: "conflict" });
    // Only fully discounted purchases use the email quota: a charged call must
    // never be refused by this check after payment.
    if (purchase.amountTotal === 0) {
      const email = normalizeCheckoutEmail(purchase.customer.email);
      if (!email) return yield* recordError("free_call_unavailable");
      const redis = yield* RedisClient;
      const freeLimit = makeFreeCallLimit(redis, environment);
      releaseFreeCall = freeLimit
        .release(email, record._id)
        .pipe(Effect.ignore);
      completeFreeCall = freeLimit.complete(email, record._id);
      yield* freeLimit.reserve(email, record._id);
    }
    // The shared Lookup cache refreshes expired results before any dial attempt.
    const preflight = yield* Preflight;
    yield* preflight.check(record.to, {
      requestId: record._id,
      room: record.room,
    });
    // The Checkout check is advisory; atomically claim capacity immediately
    // before dialing so concurrent dispatchers cannot exceed the quota.
    yield* limit.reserve(record.to, record._id);
    releaseDestination = limit
      .release(record.to, record._id)
      .pipe(Effect.ignore);
    yield* dialer.dial(record).pipe(
      Effect.timeoutFail({
        duration: "60 seconds",
        onTimeout: () => new LiveKitError({ code: "unavailable" }),
      }),
    );
    // Once the provider accepts the call, later bookkeeping failures must not
    // give either quota's capacity back.
    releaseDestination = Effect.void;
    releaseFreeCall = Effect.void;
    yield* limit.complete(record.to, record._id);
    yield* completeFreeCall;
    yield* Effect.tryPromise(() =>
      mongo.requests.updateOne(
        { _id: record._id, status: "dialing" },
        { $set: { status: "dialed", dialedAt: new Date() } },
      ),
    );
    yield* sendEmail(callDialedEmail(record, purchase));
  }).pipe(
    Effect.catchAll((e) =>
      recordError(
        e instanceof PaymentError ||
          e instanceof LiveKitError ||
          e instanceof FreeCallLimitError ||
          e instanceof PreflightError
          ? e.code
          : "internal",
      ),
    ),
    Effect.onInterrupt(() => recordError("interrupted").pipe(Effect.ignore)),
    Effect.annotateLogs({
      requestId: record._id,
      sessionId: record.checkout?.id ?? "unbound",
      room: record.room,
    }),
  );
  return true;
});

// DispatchLive polls for paid calls every second for as long as the api runs.
export const DispatchLive = Layer.scopedDiscard(
  dispatchCall.pipe(
    Effect.catchAll(() => logPaymentFailure("dispatch", "internal")),
    Effect.repeat(Schedule.spaced("1 second")),
    Effect.forkScoped,
  ),
);
