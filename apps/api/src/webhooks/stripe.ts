import { HttpServerRequest } from "@effect/platform";
import { Effect } from "effect";
import type Stripe from "stripe";
import { MongoClient } from "../clients/mongo.js";
import { sessionPayment, StripeClient } from "../clients/stripe.js";
import { PaymentError, logPaymentError } from "../handlers/payments/errors.js";
import {
  json,
  paymentResponse,
  readBody,
  recordPurchase,
} from "../handlers/payments/http.js";
import { requestSnapshotHash } from "../handlers/payments/schema.js";

// events are the Checkout events that can move a request forward.
const events = new Set([
  "checkout.session.completed",
  "checkout.session.expired",
  "checkout.session.async_payment_succeeded",
  "checkout.session.async_payment_failed",
]);

// handleStripeEvent queues the call once its payment is held and marks failed or expired sessions.
export const handleStripeEvent = (event: Stripe.Event) =>
  Effect.gen(function* () {
    if (!events.has(event.type)) return { received: true };
    const object = event.data.object as Stripe.Checkout.Session;
    if (object.object !== "checkout.session")
      return yield* new PaymentError({ code: "invalid_request" });
    const mongo = yield* MongoClient;
    const stripe = yield* StripeClient;
    const record = yield* Effect.tryPromise(() =>
      mongo.requests.findOne({ _id: object.client_reference_id ?? "" }),
    );
    if (!record) return { received: true };
    return yield* Effect.gen(function* () {
      const checkout = record.checkout;
      // a 503 makes Stripe retry an event that beat the checkout binding
      if (!checkout) return yield* new PaymentError({ code: "unavailable" });
      if (checkout.id !== object.id || event.livemode !== checkout.livemode)
        return yield* new PaymentError({ code: "conflict" });
      const verified = yield* stripe.retrieveSession(checkout.id);
      const { accountId, session } = verified;
      const digest = record.requestSnapshotHash;
      if (
        accountId !== checkout.accountId ||
        session.id !== checkout.id ||
        session.livemode !== checkout.livemode ||
        session.livemode !== (record.environment === "production") ||
        session.mode !== "payment" ||
        session.client_reference_id !== record._id ||
        session.amount_total !== record.amount ||
        session.currency !== record.currency ||
        !digest ||
        session.metadata?.request_snapshot_hash !== digest ||
        requestSnapshotHash(record) !== digest
      )
        return yield* new PaymentError({ code: "conflict" });
      // current Stripe state wins over duplicate or out-of-order events
      const payment = sessionPayment(session);
      if (!payment) {
        if (session.status === "expired")
          yield* Effect.tryPromise(() =>
            mongo.requests.updateOne(
              { _id: record._id, status: "unpaid" },
              { $set: { status: "expired" } },
            ),
          );
        else if (
          event.type === "checkout.session.async_payment_failed" &&
          session.status === "complete" &&
          session.payment_status === "unpaid"
        )
          yield* Effect.tryPromise(() =>
            mongo.requests.updateOne(
              { _id: record._id, status: { $in: ["unpaid", "expired"] } },
              { $set: { status: "failed", error: "payment_failed" } },
            ),
          );
        return { received: true };
      }
      const purchase = yield* recordPurchase(mongo.purchases, verified, record);
      // the purchase and the queue are separate writes, so retrying after either one is safe
      yield* Effect.tryPromise(() =>
        mongo.requests.updateOne(
          {
            _id: record._id,
            $or: [
              { status: { $in: ["unpaid", "expired"] } },
              { status: "failed", error: "payment_failed" },
            ],
          },
          {
            $set: {
              status: "paid",
              purchaseId: purchase._id,
              payment: {
                status: payment,
                heldAt: purchase.recordedAt,
                ...(payment === "charged" && {
                  settledAt: purchase.recordedAt,
                }),
              },
            },
            $unset: { error: "" },
          },
        ),
      );
      return { received: true };
    }).pipe(
      Effect.tapError((error) => logPaymentError("webhook", error)),
      Effect.annotateLogs({
        requestId: record._id,
        sessionId: object.id,
        eventId: event.id,
      }),
    );
  });

// stripeWebhook serves POST /webhooks/stripe.
export const stripeWebhook = paymentResponse(
  "webhook",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const stripe = yield* StripeClient;
    const payload = yield* readBody(1_000_000);
    const event = yield* stripe.verifyEvent(
      payload,
      request.headers["stripe-signature"],
    );
    return yield* json(yield* handleStripeEvent(event));
  }),
);
