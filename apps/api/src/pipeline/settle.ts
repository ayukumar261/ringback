import { Effect, Layer, PubSub, Schedule, Stream } from "effect";
import type Stripe from "stripe";
import {
  MongoClient,
  type PaymentStatus,
  type RequestDoc,
} from "../clients/mongo.js";
import { StripeClient } from "../clients/stripe.js";
import { PaymentConfig } from "../handlers/payments/config.js";
import {
  PaymentError,
  logPaymentError,
  logPaymentFailure,
} from "../handlers/payments/errors.js";
import { CallFeed } from "./feed.js";

// Settlement charges a held payment or releases it.
export type Settlement = "charge" | "release";

// RELEASE_AFTER_MS keeps a hold well past the 60-second dial and answer timeouts, so a late answer is still charged.
export const RELEASE_AFTER_MS = 5 * 60_000;

// settledStatus mirrors a PaymentIntent onto the request, or is null while the payment is still held.
const settledStatus = (intent: Stripe.PaymentIntent): PaymentStatus | null =>
  intent.status === "succeeded"
    ? "charged"
    : intent.status === "canceled"
      ? "released"
      : null;

// settlePayment charges or releases a held payment; after any error, Stripe's current state decides.
export const settlePayment = (record: RequestDoc, settlement: Settlement) =>
  Effect.gen(function* () {
    if (record.payment?.status !== "held") return null;
    const mongo = yield* MongoClient;
    const stripe = yield* StripeClient;
    const purchase = record.purchaseId
      ? yield* Effect.tryPromise(() =>
          mongo.purchases.findOne({ _id: record.purchaseId }),
        )
      : null;
    if (
      !purchase ||
      purchase.requestId !== record._id ||
      purchase.livemode !== (record.environment === "production")
    )
      return yield* new PaymentError({ code: "conflict" });
    const intentId = purchase.paymentIntentId;
    const intent = yield* (
      settlement === "charge"
        ? stripe.capturePayment(intentId, record._id)
        : stripe.releasePayment(intentId, record._id)
    ).pipe(
      Effect.tapError((error) => logPaymentError("settle", error)),
      Effect.catchAll(() => stripe.retrievePayment(intentId)),
    );
    const status = settledStatus(intent);
    if (intent.id !== intentId || !status)
      return yield* new PaymentError({ code: "unavailable" });
    yield* Effect.tryPromise(() =>
      mongo.requests.updateOne(
        { _id: record._id, "payment.status": "held" },
        {
          $set: { "payment.status": status, "payment.settledAt": new Date() },
        },
      ),
    );
    if (settlement === "charge" && status === "released")
      yield* logPaymentFailure("settle", "uncollected");
    return status;
  }).pipe(Effect.annotateLogs({ requestId: record._id, room: record.room }));

// settleCall charges or releases the held payment for a call's room, if it has one.
export const settleCall = (room: string, settlement: Settlement) =>
  Effect.gen(function* () {
    const mongo = yield* MongoClient;
    const { environment } = yield* PaymentConfig;
    const record = yield* Effect.tryPromise(() =>
      mongo.requests.findOne({ "payment.status": "held", room, environment }),
    );
    return record ? yield* settlePayment(record, settlement) : null;
  });

// sweepPayments settles holds whose call events were missed: charged once the call started, released once it can no longer start.
export const sweepPayments = Effect.gen(function* () {
  const mongo = yield* MongoClient;
  const { environment } = yield* PaymentConfig;
  const now = Date.now();
  const held = yield* Effect.tryPromise(() =>
    mongo.requests
      .find({
        "payment.status": "held",
        environment,
        status: { $in: ["dialed", "failed"] },
      })
      .sort({ claimedAt: 1 })
      .limit(100)
      .toArray(),
  );
  for (const record of held) {
    const call = yield* Effect.tryPromise(() =>
      mongo.calls.findOne({ room: record.room }),
    );
    const settlement: Settlement | null = call?.startedAt
      ? "charge"
      : (record.claimedAt ?? record.createdAt).getTime() <=
          now - RELEASE_AFTER_MS
        ? "release"
        : null;
    if (settlement)
      yield* settlePayment(record, settlement).pipe(
        Effect.catchAll((error) => logPaymentError("settle", error)),
      );
  }
});

// SettleLive charges a hold when its call starts and releases it when the call goes unanswered, with a sweep every minute for missed events.
export const SettleLive = Layer.scopedDiscard(
  Effect.gen(function* () {
    const feed = yield* CallFeed;
    const events = yield* PubSub.subscribe(feed);
    yield* Stream.fromQueue(events).pipe(
      Stream.runForEach(({ event }) =>
        event.event === "call.started" || event.event === "call.unanswered"
          ? settleCall(
              event.room,
              event.event === "call.started" ? "charge" : "release",
            ).pipe(
              Effect.catchAll((error) => logPaymentError("settle", error)),
              Effect.catchAllDefect(() =>
                logPaymentFailure("settle", "internal"),
              ),
            )
          : Effect.void,
      ),
      Effect.forkScoped,
    );
    yield* sweepPayments.pipe(
      Effect.catchAllCause(() => logPaymentFailure("settle", "internal")),
      Effect.repeat(Schedule.spaced("1 minute")),
      Effect.forkScoped,
    );
  }),
);
