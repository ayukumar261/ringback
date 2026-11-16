import { Effect } from "effect";
import type { PurchaseDoc, RequestDoc } from "../clients/mongo.js";
import { ResendClient, type Email } from "../clients/resend.js";
import { code, h1, inline, p, page, pre, strong, ul } from "./markdown.js";

// money formats cents, such as $0.50.
const money = (cents: number, currency: string) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency }).format(
    cents / 100,
  );

// callRequestedEmail says an agent created a call that's waiting for payment.
export const callRequestedEmail = (request: RequestDoc): Email => ({
  subject: `Call requested: ${request.to}`,
  html: page([
    h1("Call requested"),
    p(
      inline`An agent asked to call ${code(request.to)}. Nothing dials until Checkout is paid.`,
    ),
    ul([
      inline`${strong("Call ID:")} ${code(request._id)}`,
      inline`${strong("Price:")} ${money(request.amount, request.currency)}`,
    ]),
    pre("Prompt", request.prompt),
  ]),
});

// callDialedEmail says a paid call was dialed, and whether a coupon lowered the price.
export const callDialedEmail = (
  request: RequestDoc,
  purchase: PurchaseDoc,
): Email => {
  const paid = money(purchase.amountTotal, purchase.currency);
  return {
    subject: `Call dialed: ${request.to}`,
    html: page([
      h1("Call dialed"),
      p(inline`Corbyn AI dialed ${code(request.to)}.`),
      ul([
        inline`${strong("Call ID:")} ${code(request._id)}`,
        inline`${strong("Paid:")} ${
          purchase.amountTotal < request.amount
            ? `${paid} with a coupon (full price ${money(request.amount, request.currency)})`
            : paid
        }`,
        inline`${strong("Customer:")} ${purchase.customer.email ?? "No email"}`,
      ]),
      pre("Prompt", request.prompt),
    ]),
  };
};

// sendEmail sends in the background, so an email never delays or fails a call.
// Failures are only logged.
export const sendEmail = (email: Email) =>
  Effect.gen(function* () {
    const resend = yield* ResendClient;
    yield* resend.send(email).pipe(
      Effect.catchAll((error) =>
        Effect.logError("email: send failed").pipe(
          Effect.annotateLogs({ code: error.code }),
        ),
      ),
      Effect.forkDaemon,
    );
  });
