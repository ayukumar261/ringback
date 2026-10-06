import { createHash } from "node:crypto";
import { Effect, Schema } from "effect";
import type { RequestDoc } from "../../clients/mongo.js";
import { PaymentError } from "./errors.js";

// POLICY_VERSION names the prompt rules a request was checked against.
export const POLICY_VERSION = "prompt-rules-v1";

// MAX_DURATION caps every call at 30 minutes.
export const MAX_DURATION = 30 * 60;

// CallInput is the POST /call body, one E.164 destination and the prompt the call runs on.
export const CallInput = Schema.Struct({
  to: Schema.String.pipe(Schema.pattern(/^\+[1-9]\d{6,14}$/)),
  prompt: Schema.String.pipe(
    Schema.maxLength(16_000),
    Schema.compose(Schema.Trim),
    Schema.minLength(1),
  ),
});

// prohibited is a keyword check, not real prompt moderation.
const prohibited =
  /\b(?:prank\s+call|cold[- ]call|robocall|harass(?:ment|ing)?|impersonat\w*|bomb\s+threat|swatting)\b/i;

// checkCallInput validates a POST /call body and turns away prohibited prompts.
export const checkCallInput = (input: unknown) =>
  Schema.decodeUnknown(CallInput)(input).pipe(
    Effect.mapError(() => new PaymentError({ code: "invalid_request" })),
    Effect.flatMap((body) =>
      prohibited.test(body.prompt)
        ? Effect.fail(new PaymentError({ code: "prompt_not_allowed" }))
        : Effect.succeed(body),
    ),
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
    | "policyVersion"
    | "requireTerms"
    | "environment"
  >,
) =>
  hash([
    r.to,
    r.prompt,
    r.amount,
    r.currency,
    r.maxDuration,
    r.policyVersion,
    r.requireTerms,
    r.environment,
  ]);
