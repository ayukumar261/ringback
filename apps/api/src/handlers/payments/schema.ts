import { createHash } from "node:crypto";
import { Effect, Schema } from "effect";
import type { RequestDoc } from "../../clients/mongo.js";
import { PaymentError } from "./errors.js";

// TERMS_VERSION matches the preserved public Terms edition used by new checkouts.
export const TERMS_VERSION = "2026-11-01";

// PRIVACY_VERSION matches the preserved public Privacy Policy edition used by new checkouts.
export const PRIVACY_VERSION = "2026-10-30";

// MAX_DURATION caps every call at 30 minutes.
export const MAX_DURATION = 30 * 60;

// Stripe's expiry webhook can arrive after the payment link has already expired.
export const callRequestStatus = (
  request: Pick<RequestDoc, "status" | "expiresAt">,
) =>
  request.status === "unpaid" && request.expiresAt.getTime() <= Date.now()
    ? "expired"
    : request.status;

// callPaymentStatus reports the call's payment; purchases from before holds were charged at checkout.
export const callPaymentStatus = (
  request: Pick<RequestDoc, "payment" | "purchaseId">,
) => request.payment?.status ?? (request.purchaseId ? "charged" : "unpaid");

// CallInput is the POST /call body, one E.164 destination and the prompt the call runs on.
export const CallInput = Schema.Struct({
  to: Schema.String.pipe(Schema.pattern(/^\+[1-9]\d{6,14}$/)),
  prompt: Schema.String.pipe(
    Schema.maxLength(16_000),
    Schema.compose(Schema.Trim),
    Schema.minLength(1),
  ),
});

// checkCallInput validates the shape, destination format, and prompt length.
export const checkCallInput = (input: unknown) =>
  Schema.decodeUnknown(CallInput)(input).pipe(
    Effect.mapError(() => new PaymentError({ code: "invalid_request" })),
  );

// hash fingerprints any JSON value.
export const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

// requestSnapshotHash fingerprints the call details stored in Mongo and sent to Stripe.
export const requestSnapshotHash = (
  r: Pick<
    RequestDoc,
    | "to"
    | "prompt"
    | "amount"
    | "currency"
    | "maxDuration"
    | "terms"
    | "privacy"
    | "environment"
  >,
) =>
  hash([
    r.to,
    r.prompt,
    r.amount,
    r.currency,
    r.maxDuration,
    r.environment,
    r.terms.version,
    r.terms.url,
    r.privacy.version,
    r.privacy.url,
  ]);
