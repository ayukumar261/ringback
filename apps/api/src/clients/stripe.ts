import { Config, Data, Effect, Redacted } from "effect";
import Stripe from "stripe";
import { environmentConfig, type Environment } from "../environment.js";

// StripeError is a failed Stripe call, carrying the error code the api responds with.
export class StripeError extends Data.TaggedError("StripeError")<{
  code: "invalid_request" | "unavailable" | "internal";
  providerRequestId?: string;
}> {
  override get message() {
    return this.code;
  }
}

// CheckoutInput is everything Checkout needs to sell one call, without the destination or prompt.
export interface CheckoutInput {
  requestId: string;
  requestSnapshotHash: string;
  amount: number;
  currency: string;
  maxDuration: number;
  expiresAt: Date;
  returnUrl: string;
  requireTerms: boolean;
}

// CheckoutSession is a Checkout session plus the Stripe account that owns it.
export interface CheckoutSession {
  accountId: string;
  session: Stripe.Checkout.Session;
}

// verifyStripeEvent checks the webhook signature against the exact bytes Stripe sent.
export const verifyStripeEvent = (
  payload: Buffer,
  signature: string | undefined,
  secret: string,
) =>
  Effect.gen(function* () {
    if (!secret) return yield* new StripeError({ code: "unavailable" });
    if (!signature) return yield* new StripeError({ code: "invalid_request" });
    return yield* Effect.try({
      try: () => Stripe.webhooks.constructEvent(payload, signature, secret),
      catch: () => new StripeError({ code: "invalid_request" }),
    });
  });

// providerError keeps only Stripe's request id because raw errors can carry billing details.
const providerError = (error: unknown) =>
  new StripeError({
    code: "unavailable",
    ...(error instanceof Stripe.errors.StripeError &&
      error.requestId && { providerRequestId: error.requestId }),
  });

// makeStripeClient creates and reads Checkout sessions for one environment.
export const makeStripeClient = (
  stripe: Stripe | undefined,
  webhookSecret: string,
  environment: Environment,
) => {
  const checkEnvironment = (result: CheckoutSession) =>
    result.session.livemode === (environment === "production")
      ? Effect.succeed(result)
      : Effect.fail(new StripeError({ code: "internal" }));
  return {
    retrieveSession: (
      id: string,
    ): Effect.Effect<CheckoutSession, StripeError> =>
      stripe
        ? Effect.tryPromise({
            try: async () => {
              const [account, session] = await Promise.all([
                stripe.accounts.retrieveCurrent(),
                stripe.checkout.sessions.retrieve(id),
              ]);
              return { accountId: account.id, session };
            },
            catch: providerError,
          }).pipe(Effect.flatMap(checkEnvironment))
        : Effect.fail(new StripeError({ code: "unavailable" })),

    createSession: (
      input: CheckoutInput,
    ): Effect.Effect<CheckoutSession, StripeError> =>
      Effect.gen(function* () {
        if (!stripe || !webhookSecret)
          return yield* new StripeError({ code: "unavailable" });
        return yield* Effect.tryPromise({
          try: async () => {
            const account = await stripe.accounts.retrieveCurrent();
            const session = await stripe.checkout.sessions.create(
              {
                mode: "payment",
                allowed_payment_method_types: ["card"],
                customer_creation: "always",
                client_reference_id: input.requestId,
                metadata: {
                  request_id: input.requestId,
                  request_snapshot_hash: input.requestSnapshotHash,
                },
                line_items: [
                  {
                    quantity: 1,
                    price_data: {
                      currency: input.currency,
                      unit_amount: input.amount,
                      product_data: {
                        name: "Ringback call",
                        description: `One call, up to ${input.maxDuration / 60} minutes`,
                      },
                    },
                  },
                ],
                expires_at: Math.floor(input.expiresAt.getTime() / 1000),
                success_url: input.returnUrl,
                cancel_url: input.returnUrl,
                ...(input.requireTerms && {
                  consent_collection: { terms_of_service: "required" as const },
                }),
              },
              { idempotencyKey: `ringback-checkout-${input.requestId}` },
            );
            return { accountId: account.id, session };
          },
          catch: providerError,
        });
      }).pipe(Effect.flatMap(checkEnvironment)),
    verifyEvent: (payload: Buffer, signature: string | undefined) =>
      verifyStripeEvent(payload, signature, webhookSecret).pipe(
        Effect.filterOrFail(
          (event) => event.livemode === (environment === "production"),
          () => new StripeError({ code: "invalid_request" }),
        ),
      ),
  };
};

// stripeConfig reads the Stripe key and webhook secret for the current environment.
export const stripeConfig = Effect.gen(function* () {
  const environment = yield* environmentConfig;
  const prefix =
    environment === "production" ? "STRIPE_PRODUCTION" : "STRIPE_SANDBOX";
  return yield* Config.all({
    environment: Config.succeed(environment),
    key: Config.redacted(`${prefix}_API_KEY`).pipe(
      Config.withDefault(Redacted.make("")),
      Config.validate({
        message: `${prefix}_API_KEY must be a ${environment === "production" ? "live" : "test"} Stripe secret or restricted key`,
        validation: (key) => {
          const value = Redacted.value(key);
          return (
            value === "" ||
            (environment === "production"
              ? /^[sr]k_live_/
              : /^[sr]k_test_/
            ).test(value)
          );
        },
      }),
    ),
    webhookSecret: Config.redacted(`${prefix}_WEBHOOK_SECRET`).pipe(
      Config.withDefault(Redacted.make("")),
    ),
  });
});

// StripeClient is the api's client for Stripe Checkout.
export class StripeClient extends Effect.Service<StripeClient>()(
  "api/StripeClient",
  {
    effect: Effect.gen(function* () {
      const { key, webhookSecret, environment } = yield* stripeConfig;
      const value = Redacted.value(key);
      return makeStripeClient(
        value
          ? new Stripe(value, { timeout: 10_000, maxNetworkRetries: 1 })
          : undefined,
        Redacted.value(webhookSecret),
        environment,
      );
    }),
  },
) {}
