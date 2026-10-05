import { ConfigProvider, Effect, Redacted } from "effect";
import Stripe from "stripe";
import { describe, expect, it, vi } from "vitest";
import {
  makeStripeClient,
  StripeClient,
  stripeConfig,
  verifyStripeEvent,
  type CheckoutInput,
} from "./stripe.js";

const secret = "whsec_test_fixture";

const input: CheckoutInput = {
  requestId: "request-test",
  requestSnapshotHash: "hash",
  amount: 50,
  currency: "usd",
  maxDuration: 1800,
  expiresAt: new Date(Date.now() + 35 * 60_000),
  returnUrl: "https://example.com/call/request-test",
  requireTerms: true,
};
const sdk = () => {
  const create = vi.fn(
    async () => ({ id: "cs_test", livemode: false }) as Stripe.Checkout.Session,
  );
  const retrieve = vi.fn(
    async () => ({ id: "cs_test", livemode: false }) as Stripe.Checkout.Session,
  );
  const account = vi.fn(async () => ({ id: "acct_test" }));
  const stripe = {
    accounts: { retrieveCurrent: account },
    checkout: { sessions: { create, retrieve } },
  } as unknown as Stripe;
  return {
    create,
    retrieve,
    account,
    client: makeStripeClient(stripe, secret, "development"),
    stripe,
  };
};

describe("Stripe client", () => {
  it("creates a fixed-price session with stable idempotency and return URLs", async () => {
    const s = sdk();
    await Effect.runPromise(s.client.createSession(input));
    expect(s.create).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "payment",
        allowed_payment_method_types: ["card"],
        client_reference_id: input.requestId,
        customer_creation: "always",
        metadata: {
          request_id: input.requestId,
          request_snapshot_hash: "hash",
        },
        expires_at: Math.floor(input.expiresAt.getTime() / 1000),
        success_url: "https://example.com/call/request-test",
        cancel_url: "https://example.com/call/request-test",
        consent_collection: { terms_of_service: "required" },
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: "usd",
              unit_amount: 50,
              product_data: {
                name: "Ringback call",
                description: "One call, up to 30 minutes",
              },
            },
          },
        ],
      }),
      { idempotencyKey: "ringback-checkout-request-test" },
    );
  });
  it("omits consent collection when not required", async () => {
    const s = sdk();
    await Effect.runPromise(
      s.client.createSession({
        ...input,
        requireTerms: false,
      }),
    );
    const [args] = s.create.mock.calls[0] as unknown as [
      Stripe.Checkout.SessionCreateParams,
    ];
    expect(args.consent_collection).toBeUndefined();
    expect(args.metadata).toEqual({
      request_id: "request-test",
      request_snapshot_hash: "hash",
    });
  });
  it("retrieves authoritative account and session state", async () => {
    const s = sdk();
    expect(
      await Effect.runPromise(s.client.retrieveSession("cs_test")),
    ).toMatchObject({ accountId: "acct_test", session: { id: "cs_test" } });
    expect(s.retrieve).toHaveBeenCalledWith("cs_test");
  });
  it("refuses unconfigured credentials and signing secrets before creating a session", async () => {
    const s = sdk();
    for (const client of [
      makeStripeClient(undefined, secret, "development"),
      makeStripeClient(s.stripe, "", "development"),
    ]) {
      await expect(
        Effect.runPromise(client.createSession(input)),
      ).rejects.toThrow("unavailable");
    }
    expect(s.create).not.toHaveBeenCalled();
    await expect(
      Effect.runPromise(
        makeStripeClient(undefined, secret, "development").retrieveSession("x"),
      ),
    ).rejects.toThrow("unavailable");
  });
  it("sanitizes provider failures and keeps only the provider request ID", async () => {
    const s = sdk();
    s.create.mockRejectedValueOnce(
      new Stripe.errors.StripeAPIError({
        message: "secret billing details",
        requestId: "req_123",
      }),
    );
    const result = await Effect.runPromise(
      s.client.createSession(input).pipe(Effect.flip),
    );
    expect(result).toMatchObject({
      code: "unavailable",
      providerRequestId: "req_123",
    });
    expect(JSON.stringify(result)).not.toContain("secret billing");
    s.retrieve.mockRejectedValueOnce(new Error("secret"));
    await expect(
      Effect.runPromise(s.client.retrieveSession("x")),
    ).rejects.toThrow("unavailable");
  });
  it.each(["development", "production"] as const)(
    "rejects Checkout sessions from the wrong environment in %s",
    async (environment) => {
      const s = sdk();
      const client = makeStripeClient(s.stripe, secret, environment);
      const wrong = {
        id: "cs_wrong",
        livemode: environment !== "production",
      } as Stripe.Checkout.Session;
      s.create.mockResolvedValueOnce(wrong);
      s.retrieve.mockResolvedValueOnce(wrong);
      await expect(
        Effect.runPromise(client.createSession(input)),
      ).rejects.toThrow("internal");
      await expect(
        Effect.runPromise(client.retrieveSession("cs_wrong")),
      ).rejects.toThrow("internal");
      s.create.mockResolvedValueOnce({
        ...wrong,
        livemode: environment === "production",
      });
      await expect(
        Effect.runPromise(client.createSession(input)),
      ).resolves.toMatchObject({
        session: { livemode: environment === "production" },
      });
    },
  );
  it.each(["development", "production"] as const)(
    "only accepts signed webhooks matching %s",
    async (environment) => {
      const client = makeStripeClient(sdk().stripe, secret, environment);
      for (const livemode of [false, true]) {
        const payload = JSON.stringify({
          id: "evt_test",
          object: "event",
          livemode,
        });
        const signature = Stripe.webhooks.generateTestHeaderString({
          payload,
          secret,
        });
        const result = Effect.runPromise(
          client.verifyEvent(Buffer.from(payload), signature),
        );
        if (livemode === (environment === "production"))
          await expect(result).resolves.toMatchObject({ livemode });
        else await expect(result).rejects.toThrow("invalid_request");
      }
    },
  );
  it("boots without credentials and fails only payment operations", async () => {
    const client = await Effect.runPromise(
      StripeClient.pipe(
        Effect.provide(StripeClient.Default),
        Effect.withConfigProvider(ConfigProvider.fromMap(new Map())),
      ),
    );
    await expect(
      Effect.runPromise(client.createSession(input)),
    ).rejects.toThrow("unavailable");
  });
});

describe("Stripe environment configuration", () => {
  const load = (values: Record<string, string | undefined> = {}) =>
    Effect.runPromise(
      stripeConfig.pipe(
        Effect.withConfigProvider(
          ConfigProvider.fromMap(
            new Map(
              Object.entries(values).filter(
                (entry): entry is [string, string] => entry[1] !== undefined,
              ),
            ),
          ),
        ),
      ),
    );
  const credentials = {
    STRIPE_SANDBOX_API_KEY: "sk_test_sandbox_fixture",
    STRIPE_SANDBOX_WEBHOOK_SECRET: "whsec_sandbox_fixture",
    STRIPE_PRODUCTION_API_KEY: "sk_live_production_fixture",
    STRIPE_PRODUCTION_WEBHOOK_SECRET: "whsec_production_fixture",
  };
  it.each([undefined, "development", "production"])(
    "selects the matching credentials for NODE_ENV=%s",
    async (environment) => {
      const config = await load({
        ...credentials,
        ...(environment ? { NODE_ENV: environment } : {}),
      });
      const prefix =
        environment === "production" ? "STRIPE_PRODUCTION" : "STRIPE_SANDBOX";
      expect(config.environment).toBe(environment ?? "development");
      expect(Redacted.value(config.key)).toBe(credentials[`${prefix}_API_KEY`]);
      expect(Redacted.value(config.webhookSecret)).toBe(
        credentials[`${prefix}_WEBHOOK_SECRET`],
      );
    },
  );
  it.each([
    {
      NODE_ENV: "development",
      STRIPE_SANDBOX_API_KEY: "sk_live_wrong_environment",
    },
    {
      NODE_ENV: "production",
      STRIPE_PRODUCTION_API_KEY: "sk_test_wrong_environment",
    },
    { NODE_ENV: "development", STRIPE_SANDBOX_API_KEY: "pk_test_public_key" },
  ])(
    "rejects credentials for the wrong environment without leaking them",
    async (values) => {
      const error = await load(values).catch((error: Error) => error);
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).toContain("Stripe secret or restricted key");
      expect(String(error)).not.toContain("wrong_environment");
      expect(String(error)).not.toContain("public_key");
    },
  );
  it.each(["development", "production"] as const)(
    "does not fall back to the other environment's credentials in %s",
    async (environment) => {
      const other =
        environment === "production" ? "STRIPE_SANDBOX" : "STRIPE_PRODUCTION";
      const config = await load({
        NODE_ENV: environment,
        [`${other}_API_KEY`]: credentials[`${other}_API_KEY`],
        [`${other}_WEBHOOK_SECRET`]: credentials[`${other}_WEBHOOK_SECRET`],
      });
      expect(Redacted.value(config.key)).toBe("");
      expect(Redacted.value(config.webhookSecret)).toBe("");
    },
  );
});

describe("Stripe signature verification", () => {
  const payload = '{ "id": "evt_test", "object": "event" }';
  const signature = Stripe.webhooks.generateTestHeaderString({
    payload,
    secret,
  });
  it("accepts exact signed bytes", async () => {
    expect(
      (
        await Effect.runPromise(
          verifyStripeEvent(Buffer.from(payload), signature, secret),
        )
      ).id,
    ).toBe("evt_test");
  });
  it.each([
    undefined,
    "bad",
    Stripe.webhooks.generateTestHeaderString({ payload, secret, timestamp: 1 }),
  ])("rejects invalid or stale signatures", async (header) => {
    await expect(
      Effect.runPromise(
        verifyStripeEvent(Buffer.from(payload), header, secret),
      ),
    ).rejects.toThrow("invalid_request");
  });
  it("rejects an altered payload and an unconfigured secret", async () => {
    await expect(
      Effect.runPromise(
        verifyStripeEvent(Buffer.from(payload + " "), signature, secret),
      ),
    ).rejects.toThrow("invalid_request");
    await expect(
      Effect.runPromise(verifyStripeEvent(Buffer.from(payload), signature, "")),
    ).rejects.toThrow("unavailable");
  });
});
