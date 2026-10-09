import { Data, Effect } from "effect";
import { StripeError } from "../../clients/stripe.js";
import { LiveKitError } from "../../clients/livekit.js";

// PaymentError is a failed payments step, carrying the error code the api responds with.
export class PaymentError extends Data.TaggedError("PaymentError")<{
  code:
    | "invalid_request"
    | "unauthorized"
    | "not_found"
    | "conflict"
    | "prompt_not_allowed"
    | "unavailable";
}> {
  override get message() {
    return this.code;
  }
}

// logPaymentFailure logs the failed operation and its error code without the raw error.
export const logPaymentFailure = (operation: string, code: string) =>
  Effect.logError("payments: operation failed").pipe(
    Effect.annotateLogs({ operation, code }),
  );

// logPaymentError logs a payments failure by its error code and Stripe request id.
export const logPaymentError = (operation: string, error: unknown) =>
  logPaymentFailure(
    operation,
    error instanceof PaymentError ||
      error instanceof StripeError ||
      error instanceof LiveKitError
      ? error.code
      : "internal",
  ).pipe(
    Effect.annotateLogs(
      error instanceof StripeError && error.providerRequestId
        ? { providerRequestId: error.providerRequestId }
        : {},
    ),
  );
