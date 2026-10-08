import { Effect, Layer, Schedule } from "effect";
import { MongoClient } from "../clients/mongo.js";
import { LiveKitClient, LiveKitError } from "../clients/livekit.js";
import { PaymentConfig } from "../handlers/payments/config.js";
import {
  PaymentError,
  logPaymentFailure,
} from "../handlers/payments/errors.js";
import { requestSnapshotHash } from "../handlers/payments/schema.js";

// dispatchCall claims the oldest paid call and dials it once, since a failed dial may have gone through.
export const dispatchCall = Effect.gen(function* () {
  const mongo = yield* MongoClient;
  const settings = yield* PaymentConfig;
  const dialer = yield* LiveKitClient;
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
  if (stale.modifiedCount)
    yield* logPaymentFailure("dispatch", "interrupted").pipe(
      Effect.annotateLogs({ count: stale.modifiedCount }),
    );
  const record = yield* Effect.tryPromise(() =>
    mongo.requests.findOneAndUpdate(
      { status: "paid", environment },
      { $set: { status: "dialing", claimedAt: new Date() } },
      { sort: { createdAt: 1 }, returnDocument: "after" },
    ),
  );
  if (!record) return false;
  const recordError = (code: string) =>
    Effect.gen(function* () {
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
      purchase.amountTotal !== record.amount ||
      purchase.currency !== record.currency ||
      requestSnapshotHash(record) !== record.requestSnapshotHash
    )
      return yield* new PaymentError({ code: "conflict" });
    yield* dialer.dial(record).pipe(
      Effect.timeoutFail({
        duration: "60 seconds",
        onTimeout: () => new LiveKitError({ code: "unavailable" }),
      }),
    );
    yield* Effect.tryPromise(() =>
      mongo.requests.updateOne(
        { _id: record._id, status: "dialing" },
        { $set: { status: "dialed", dialedAt: new Date() } },
      ),
    );
  }).pipe(
    Effect.catchAll((e) =>
      recordError(
        e instanceof PaymentError || e instanceof LiveKitError
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
