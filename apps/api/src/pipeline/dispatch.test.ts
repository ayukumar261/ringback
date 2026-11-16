import { randomUUID } from "node:crypto";
import { MongoClient as Driver } from "mongodb";
import { Redis } from "ioredis";
import { RedisClient } from "../clients/redis.js";
import type Stripe from "stripe";
import {
  MongoClient,
  createRequestIndexes,
  createPurchaseIndexes,
  type RequestDoc,
  type PurchaseDoc,
} from "../clients/mongo.js";
import {
  LiveKitClient,
  LiveKitError,
  type DialInput,
} from "../clients/livekit.js";
import { StripeClient } from "../clients/stripe.js";
import { ResendClient, type Email } from "../clients/resend.js";
import { PaymentConfig } from "../handlers/payments/config.js";
import {
  hash,
  MAX_DURATION,
  requestSnapshotHash,
} from "../handlers/payments/schema.js";
import { Effect, Fiber } from "effect";
import {
  describe,
  expect,
  it,
  vi,
  beforeAll,
  beforeEach,
  afterAll,
} from "vitest";
import { dispatchCall, DispatchLive } from "./dispatch.js";
import { readCallRequest } from "../handlers/payments/http.js";
import { newAccessToken, newCallAccess } from "../handlers/payments/access.js";
import { handleStripeEvent } from "../webhooks/stripe.js";

import { Preflight } from "../preflight/preflight.js";
import { PreflightError } from "../preflight/errors.js";
import { CallLimit, makeCallLimit } from "../preflight/limit.js";
import type { PhoneLookup } from "../clients/twilio.js";

const accessToken = newAccessToken();

const input = {
  to: "+15551234567",
  prompt: "Ask for an economy flight price from SFO to LAX.",
};
const settings = {
  amount: 50,
  currency: "usd",
  publicApiUrl: "http://localhost:3001",
  publicWebUrl: "http://localhost:3000",
  environment: "production" as const,
};
type Settings = Omit<PaymentConfig, "_tag">;
const mongoUri = process.env.MONGODB_URI;
const redisUrl = process.env.REDIS_URL;
const requestFixture = (changes: Partial<RequestDoc> = {}): RequestDoc => {
  const record = {
    _id: "request-test",
    ...input,
    inputHash: hash(input),
    access: newCallAccess(accessToken, new Date()),
    dashboardUrl: `${settings.publicWebUrl}/call/${changes._id ?? "request-test"}`,
    ...settings,
    maxDuration: MAX_DURATION,
    terms: {
      version: "2026-10-30",
      url: "https://example.com/terms-and-conditions/2026-10-30",
    },
    privacy: {
      version: "2026-10-30",
      url: "https://example.com/privacy-policy/2026-10-30",
    },
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 60 * 60_000),
    status: "unpaid",
    room: "call_request-test",
    checkout: {
      id: "cs_test",
      url: "https://checkout.stripe.com/test",
      accountId: "acct_test",
      livemode: true,
    },
    ...changes,
  } satisfies Omit<RequestDoc, "requestSnapshotHash">;
  return {
    ...record,
    requestSnapshotHash:
      changes.requestSnapshotHash ?? requestSnapshotHash(record),
  };
};
const sessionFixture = (changes: Partial<Stripe.Checkout.Session> = {}) =>
  ({
    id: "cs_test",
    object: "checkout.session",
    mode: "payment",
    status: "complete",
    payment_status: "paid",
    consent: { terms_of_service: "accepted", promotions: null },
    livemode: true,
    client_reference_id: "request-test",
    amount_subtotal: 50,
    amount_total: 50,
    currency: "usd",
    metadata: {
      request_snapshot_hash: requestFixture().requestSnapshotHash,
      terms_version: requestFixture().terms.version,
      terms_url: requestFixture().terms.url,
      privacy_version: requestFixture().privacy.version,
      privacy_url: requestFixture().privacy.url,
    },
    url: "https://checkout.stripe.com/test",
    customer: "cus_test",
    payment_intent: "pi_test",
    customer_details: {
      name: "Test payer",
      email: "payer@example.com",
      phone: null,
    },
    ...changes,
  }) as Stripe.Checkout.Session;
const purchaseFixture = (changes: Partial<PurchaseDoc> = {}): PurchaseDoc => ({
  _id: "acct_test:live:cs_test",
  requestId: "request-test",
  stripeAccountId: "acct_test",
  livemode: true,
  checkoutSessionId: "cs_test",
  paymentIntentId: "pi_test",
  customer: {
    stripeId: "cus_test",
    name: null,
    email: "payer@example.com",
    phone: null,
  },
  amountTotal: 50,
  currency: "usd",
  recordedAt: new Date(),
  terms: {
    version: "2026-10-30",
    url: "https://example.com/terms-and-conditions/2026-10-30",
  },
  privacy: {
    version: "2026-10-30",
    url: "https://example.com/privacy-policy/2026-10-30",
  },
  ...changes,
});
const event = (
  session: Stripe.Checkout.Session,
  type = "checkout.session.completed",
) =>
  ({
    id: "evt_test",
    type,
    livemode: session.livemode,
    data: { object: structuredClone(session) },
  }) as Stripe.Event;

const fakeMongo = () => ({
  requests: {
    updateMany: vi.fn(async () => ({ modifiedCount: 0 })),
    findOneAndUpdate: vi.fn<(...args: unknown[]) => Promise<RequestDoc | null>>(
      async () => null,
    ),
    updateOne: vi.fn(async () => ({ modifiedCount: 1 })),
  },
  purchases: {
    findOne: vi.fn<(...args: unknown[]) => Promise<PurchaseDoc | null>>(
      async () => null,
    ),
  },
});
const fakeRedis = () => ({
  eval: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => 1),
});
const harness = (
  mongo:
    | Pick<MongoClient, "requests" | "purchases">
    | ReturnType<typeof fakeMongo> = fakeMongo(),
  redis: Pick<Redis, "eval"> = fakeRedis(),
  destinationLimit = CallLimit.make({
    check: () => Effect.void,
    reserve: () => Effect.void,
    complete: () => Effect.void,
    release: () => Effect.void,
  }),
) => {
  const ready = vi.fn(async () => {});
  const dial = vi.fn<(request: DialInput) => Promise<void>>(async () => {});
  const send = vi.fn<(email: Email) => void>();
  const dialer = LiveKitClient.make({
    ready: Effect.promise(() => ready()),
    dial: (request) =>
      Effect.tryPromise({
        try: () => dial(request),
        catch: () => new LiveKitError({ code: "unavailable" }),
      }),
  });
  const check = vi.fn<
    (number: string) => Effect.Effect<PhoneLookup, PreflightError>
  >((number) =>
    Effect.succeed({
      number,
      valid: true,
      country: "US",
      lineType: "mobile",
      lineTypeError: null,
      checkedAt: Date.now(),
      expiresAt: Date.now() + 3_600_000,
    }),
  );
  const provide = <A, E, R>(
    effect: Effect.Effect<A, E, R>,
    overrides: Partial<Settings> = {},
  ) =>
    effect.pipe(
      Effect.provideService(MongoClient, mongo as MongoClient),
      Effect.provideService(RedisClient, redis as RedisClient),
      Effect.provideService(LiveKitClient, dialer),
      Effect.provideService(
        ResendClient,
        ResendClient.make({ send: (email) => Effect.sync(() => send(email)) }),
      ),
      Effect.provideService(Preflight, Preflight.make({ check })),
      Effect.provideService(CallLimit, destinationLimit),
      Effect.provideService(
        PaymentConfig,
        PaymentConfig.make({ ...settings, ...overrides }),
      ),
    );
  return {
    check,
    ready,
    dial,
    send,
    provide,
    run: <A, E>(
      effect: Effect.Effect<
        A,
        E,
        | MongoClient
        | RedisClient
        | LiveKitClient
        | ResendClient
        | PaymentConfig
        | Preflight
        | CallLimit
      >,
      overrides: Partial<Settings> = {},
    ) => Effect.runPromise(provide(effect, overrides)),
  };
};

describe("paid dispatch", () => {
  it.each([0, 25, 50])(
    "dials a verified purchase discounted to %s cents",
    async (amountTotal) => {
      const mongo = fakeMongo();
      mongo.requests.findOneAndUpdate.mockResolvedValue(
        requestFixture({
          status: "dialing",
          purchaseId: "acct_test:live:cs_test",
        }),
      );
      mongo.purchases.findOne.mockResolvedValue(
        purchaseFixture({
          amountSubtotal: 50,
          amountTotal,
          paymentIntentId: amountTotal === 0 ? null : "pi_test",
        }),
      );
      const h = harness(mongo);
      await h.run(dispatchCall);
      expect(h.dial).toHaveBeenCalledTimes(1);
      expect(mongo.requests.updateOne).toHaveBeenCalledWith(
        { _id: "request-test", status: "dialing" },
        { $set: { status: "dialed", dialedAt: expect.any(Date) } },
      );
      await vi.waitFor(() =>
        expect(h.send).toHaveBeenCalledWith({
          subject: "Call dialed: +15551234567",
          html: expect.stringContaining(
            amountTotal < 50 ? "with a coupon" : "$0.50</li>",
          ),
        }),
      );
    },
  );
  it("rejects a discounted purchase with the wrong original price", async () => {
    const mongo = fakeMongo();
    mongo.requests.findOneAndUpdate.mockResolvedValue(
      requestFixture({
        status: "dialing",
        purchaseId: "acct_test:live:cs_test",
      }),
    );
    mongo.purchases.findOne.mockResolvedValue(
      purchaseFixture({
        amountSubtotal: 100,
        amountTotal: 0,
        paymentIntentId: null,
      }),
    );
    const h = harness(mongo);
    await h.run(dispatchCall);
    expect(h.dial).not.toHaveBeenCalled();
    expect(h.send).not.toHaveBeenCalled();
  });
  it("reserves and completes a free call in Redis", async () => {
    const mongo = fakeMongo();
    const redis = fakeRedis();
    mongo.requests.findOneAndUpdate.mockResolvedValue(
      requestFixture({
        status: "dialing",
        purchaseId: "acct_test:live:cs_test",
      }),
    );
    mongo.purchases.findOne.mockResolvedValue(
      purchaseFixture({
        amountSubtotal: 50,
        amountTotal: 0,
        paymentIntentId: null,
      }),
    );
    const h = harness(mongo, redis);
    await h.run(dispatchCall);
    expect(h.dial).toHaveBeenCalledTimes(1);
    expect(redis.eval).toHaveBeenCalledTimes(2);
    expect(mongo.requests.updateOne).toHaveBeenCalledExactlyOnceWith(
      { _id: "request-test", status: "dialing" },
      { $set: { status: "dialed", dialedAt: expect.any(Date) } },
    );
  });
  it("refuses a free call before preflight or dialing when Redis denies a slot", async () => {
    const mongo = fakeMongo();
    const redis = fakeRedis();
    mongo.requests.findOneAndUpdate.mockResolvedValue(
      requestFixture({
        status: "dialing",
        purchaseId: "acct_test:live:cs_test",
      }),
    );
    mongo.purchases.findOne.mockResolvedValue(
      purchaseFixture({
        amountSubtotal: 50,
        amountTotal: 0,
        paymentIntentId: null,
      }),
    );
    redis.eval.mockResolvedValueOnce(0);
    const h = harness(mongo, redis);
    await h.run(dispatchCall);
    expect(h.check).not.toHaveBeenCalled();
    expect(h.dial).not.toHaveBeenCalled();
    expect(mongo.requests.updateOne).toHaveBeenCalledWith(
      { _id: "request-test", status: "dialing" },
      { $set: { status: "failed", error: "daily_free_call_limit" } },
    );
  });
  it.each([25, 50])(
    "bypasses the Redis quota for a %s-cent purchase even when Redis fails",
    async (amountTotal) => {
      const mongo = fakeMongo();
      const redis = fakeRedis();
      mongo.requests.findOneAndUpdate.mockResolvedValue(
        requestFixture({
          status: "dialing",
          purchaseId: "acct_test:live:cs_test",
        }),
      );
      mongo.purchases.findOne.mockResolvedValue(
        purchaseFixture({ amountSubtotal: 50, amountTotal }),
      );
      redis.eval.mockRejectedValue(new Error("Redis unavailable"));
      const h = harness(mongo, redis);
      await h.run(dispatchCall);
      expect(redis.eval).not.toHaveBeenCalled();
      expect(h.dial).toHaveBeenCalledTimes(1);
    },
  );
  it("fails a free call if Redis cannot check the quota", async () => {
    const mongo = fakeMongo();
    const redis = fakeRedis();
    mongo.requests.findOneAndUpdate.mockResolvedValue(
      requestFixture({
        status: "dialing",
        purchaseId: "acct_test:live:cs_test",
      }),
    );
    mongo.purchases.findOne.mockResolvedValue(
      purchaseFixture({
        amountSubtotal: 50,
        amountTotal: 0,
        paymentIntentId: null,
      }),
    );
    redis.eval.mockRejectedValueOnce(new Error("Redis unavailable"));
    const h = harness(mongo, redis);
    await h.run(dispatchCall);
    expect(h.dial).not.toHaveBeenCalled();
    expect(mongo.requests.updateOne).toHaveBeenCalledWith(
      { _id: "request-test", status: "dialing" },
      { $set: { status: "failed", error: "free_call_limit_unavailable" } },
    );
  });
  it.each([0, 25, 50])(
    "only requires a Checkout email for a free purchase (%s cents)",
    async (amountTotal) => {
      const mongo = fakeMongo();
      mongo.requests.findOneAndUpdate.mockResolvedValue(
        requestFixture({
          status: "dialing",
          purchaseId: "acct_test:live:cs_test",
        }),
      );
      mongo.purchases.findOne.mockResolvedValue(
        purchaseFixture({
          amountSubtotal: 50,
          amountTotal,
          customer: {
            stripeId: "cus_test",
            name: null,
            email: null,
            phone: null,
          },
        }),
      );
      const redis = fakeRedis();
      const h = harness(mongo, redis);
      await h.run(dispatchCall);
      expect(redis.eval).not.toHaveBeenCalled();
      expect(h.dial).toHaveBeenCalledTimes(amountTotal === 0 ? 0 : 1);
      if (amountTotal === 0)
        expect(mongo.requests.updateOne).toHaveBeenCalledWith(
          { _id: "request-test", status: "dialing" },
          { $set: { status: "failed", error: "free_call_unavailable" } },
        );
    },
  );
  it.each([
    "unsupported_country",
    "unsupported_line_type",
    "lookup_unavailable",
    "daily_call_limit",
    "call_limit_unavailable",
  ] as const)("does not dial when preflight returns %s", async (code) => {
    const mongo = fakeMongo();
    mongo.requests.findOneAndUpdate.mockResolvedValue(
      requestFixture({
        status: "dialing",
        purchaseId: "acct_test:live:cs_test",
      }),
    );
    mongo.purchases.findOne.mockResolvedValue(purchaseFixture());
    const h = harness(mongo);
    h.check.mockReturnValueOnce(Effect.fail(new PreflightError({ code })));
    await h.run(dispatchCall);
    expect(h.check).toHaveBeenCalledWith(input.to, {
      requestId: "request-test",
      room: "call_request-test",
    });
    expect(h.dial).not.toHaveBeenCalled();
    expect(mongo.requests.updateOne).toHaveBeenCalledWith(
      { _id: "request-test", status: "dialing" },
      { $set: { status: "failed", error: code } },
    );
  });

  it.each(["development", "production"] as const)(
    "only claims and recovers %s requests",
    async (environment) => {
      const mongo = fakeMongo();
      const h = harness(mongo);
      expect(await h.run(dispatchCall, { environment })).toBe(false);
      expect(mongo.requests.findOneAndUpdate).toHaveBeenCalledWith(
        { status: "paid", environment },
        expect.anything(),
        expect.anything(),
      );
      expect(mongo.requests.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ environment }),
        expect.anything(),
      );
      expect(h.dial).not.toHaveBeenCalled();
    },
  );
  it("does nothing when the queue is empty", async () => {
    const h = harness();
    expect(await h.run(dispatchCall)).toBe(false);
    expect(h.dial).not.toHaveBeenCalled();
  });
  it("records an error when a dial times out", async () => {
    vi.useFakeTimers();
    try {
      const mongo = fakeMongo();
      mongo.requests.findOneAndUpdate.mockResolvedValue(
        requestFixture({
          status: "dialing",
          purchaseId: "acct_test:live:cs_test",
        }),
      );
      mongo.purchases.findOne.mockResolvedValue(purchaseFixture());
      const h = harness(mongo);
      h.dial.mockImplementationOnce(() => new Promise(() => {}));
      const pending = h.run(dispatchCall);
      await vi.advanceTimersByTimeAsync(61_000);
      await pending;
      expect(mongo.requests.updateOne).toHaveBeenCalledWith(
        { _id: "request-test", status: "dialing" },
        { $set: { status: "failed", error: "unavailable" } },
      );
    } finally {
      vi.useRealTimers();
    }
  });
  it("records an error when a dial is interrupted", async () => {
    const mongo = fakeMongo();
    mongo.requests.findOneAndUpdate.mockResolvedValue(
      requestFixture({
        status: "dialing",
        purchaseId: "acct_test:live:cs_test",
      }),
    );
    mongo.purchases.findOne.mockResolvedValue(purchaseFixture());
    const h = harness(mongo);
    let started!: () => void;
    const signal = new Promise<void>((r) => {
      started = r;
    });
    h.dial.mockImplementationOnce(() => {
      started();
      return new Promise(() => {});
    });
    const fiber = Effect.runFork(h.provide(dispatchCall));
    await signal;
    await Effect.runPromise(Fiber.interrupt(fiber));
    expect(mongo.requests.updateOne).toHaveBeenCalledWith(
      { _id: "request-test", status: "dialing" },
      { $set: { status: "failed", error: "interrupted" } },
    );
  });
  it("scopes the worker and retries database failures", async () => {
    vi.useFakeTimers();
    try {
      const mongo = fakeMongo();
      mongo.requests.updateMany.mockRejectedValueOnce(
        new Error("database unavailable"),
      );
      const h = harness(mongo);
      const fiber = Effect.runFork(
        h.provide(
          Effect.scoped(Effect.never.pipe(Effect.provide(DispatchLive))),
        ),
      );
      await vi.advanceTimersByTimeAsync(1100);
      expect(mongo.requests.updateMany).toHaveBeenCalledTimes(2);
      await Effect.runPromise(Fiber.interrupt(fiber));
      await vi.advanceTimersByTimeAsync(2000);
      expect(mongo.requests.updateMany).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe.skipIf(!mongoUri || !redisUrl)("dispatch persistence", () => {
  const driver = new Driver(mongoUri ?? "mongodb://127.0.0.1:27017", {
    serverSelectionTimeoutMS: 3000,
  });
  const db = driver.db(`ringback_test_${randomUUID().replaceAll("-", "")}`);
  const prefix = `test:${randomUUID()}:`;
  const redis = new Redis(redisUrl ?? "redis://127.0.0.1:6379", {
    keyPrefix: prefix,
    lazyConnect: true,
    maxRetriesPerRequest: 1,
  });
  const clearQuota = async () => {
    const keys = await redis.keys(`${prefix}*`);
    if (keys.length)
      await redis.del(...keys.map((key) => key.slice(prefix.length)));
  };
  const mongo = {
    requests: db.collection<RequestDoc>("requests"),
    purchases: db.collection<PurchaseDoc>("purchases"),
  };
  const destinationLimit = CallLimit.make(makeCallLimit(redis, "production"));
  beforeAll(async () => {
    await Promise.all([driver.connect(), redis.connect()]);
    await Promise.all([
      createRequestIndexes(mongo.requests),
      createPurchaseIndexes(mongo.purchases),
    ]);
  });
  beforeEach(async () => {
    await Promise.all(
      Object.values(mongo).map((collection) => collection.deleteMany({})),
    );
    await clearQuota();
    vi.clearAllMocks();
  });
  afterAll(async () => {
    try {
      await Promise.all([db.dropDatabase(), clearQuota()]);
    } finally {
      await Promise.all([driver.close(), redis.quit()]);
    }
  });
  const h = {
    ...harness(mongo, redis, destinationLimit),
    mongo,
    // paid seeds a paid, queued request without calling the other handlers
    paid: async (overrides: Partial<Pick<RequestDoc, "environment">> = {}) => {
      const livemode =
        (overrides.environment ?? settings.environment) === "production";
      const purchase = purchaseFixture({ livemode });
      const record = requestFixture({
        ...overrides,
        checkout: { ...requestFixture().checkout!, livemode },
        status: "paid",
        purchaseId: purchase._id,
        paidAt: purchase.recordedAt,
      });
      await mongo.requests.insertOne(record);
      await mongo.purchases.insertOne(purchase);
      const session = sessionFixture({
        livemode,
        metadata: {
          request_snapshot_hash: record.requestSnapshotHash,
          terms_version: record.terms.version,
          terms_url: record.terms.url,
          privacy_version: record.privacy.version,
          privacy_url: record.privacy.url,
        },
      });
      return { result: { call_id: record._id }, session };
    },
  };
  const receiveCheckout = (session: Stripe.Checkout.Session) =>
    h.run(
      handleStripeEvent(event(session)).pipe(
        Effect.provideService(
          StripeClient,
          StripeClient.make({
            retrieveSession: () =>
              Effect.succeed({ accountId: "acct_test", session }),
            createSession: () =>
              Effect.dieMessage("Unexpected Checkout creation"),
            verifyEvent: () =>
              Effect.dieMessage("Unexpected signature verification"),
          }),
        ),
      ),
    );
  const completedCheckout = async (
    id: string,
    email: string,
    amountTotal = 0,
    to = input.to,
  ) => {
    const record = requestFixture({
      to,
      _id: id,
      room: `call_${id}`,
      checkout: { ...requestFixture().checkout!, id: `cs_${id}` },
    });
    await mongo.requests.insertOne(record);
    const session = sessionFixture({
      id: record.checkout!.id,
      client_reference_id: id,
      amount_total: amountTotal,
      payment_status: amountTotal === 0 ? "no_payment_required" : "paid",
      payment_intent: amountTotal === 0 ? null : `pi_${id}`,
      customer_details: { ...sessionFixture().customer_details!, email },
      metadata: {
        ...sessionFixture().metadata,
        request_snapshot_hash: record.requestSnapshotHash,
      },
    });
    await receiveCheckout(session);
    return session;
  };
  it("allows 3 free calls across email aliases, refuses the fourth, and keeps its redemption consumed", async () => {
    const emails = [
      "First.Last@gmail.com",
      "firstlast+two@gmail.com",
      "  FIRST.LAST+three@GOOGLEMAIL.COM  ",
      "first.last+four@gmail.com",
    ];
    for (const [index, email] of emails.entries()) {
      const id = `free-${index}`;
      const session = await completedCheckout(id, email);
      expect(await mongo.requests.findOne({ _id: id })).not.toHaveProperty(
        "freeCallEmail",
      );
      await h.run(dispatchCall);
      expect(await h.run(readCallRequest(id, accessToken))).toMatchObject({
        status: index < 3 ? "dialed" : "failed",
        error: index < 3 ? null : "daily_free_call_limit",
      });
      if (index === 3) {
        await receiveCheckout(session);
        expect(await h.run(dispatchCall)).toBe(false);
        expect((await mongo.requests.findOne({ _id: id }))?.error).toBe(
          "daily_free_call_limit",
        );
      }
    }
    expect(h.dial).toHaveBeenCalledTimes(3);
    expect(await mongo.purchases.countDocuments({ amountTotal: 0 })).toBe(4);
  });
  it.each([25, 50])(
    "still dials a %s-cent purchase after the email has used all 3 free calls",
    async (amountTotal) => {
      for (let index = 0; index < 3; index++) {
        await completedCheckout(`free-${index}`, "payer+free@example.com");
        await h.run(dispatchCall);
      }
      await completedCheckout(
        "paid-call",
        "PAYER+paid@example.com",
        amountTotal,
        "+15551234568",
      );
      expect(
        await mongo.requests.findOne({ _id: "paid-call" }),
      ).not.toHaveProperty("freeCallEmail");
      await h.run(dispatchCall);
      expect(
        await h.run(readCallRequest("paid-call", accessToken)),
      ).toMatchObject({ status: "dialed", error: null });
      expect(h.dial).toHaveBeenCalledTimes(4);
    },
  );
  it("allows exactly 3 free calls across concurrent dispatchers", async () => {
    await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        completedCheckout(`free-${index}`, "payer@example.com"),
      ),
    );
    await Promise.all(Array.from({ length: 10 }, () => h.run(dispatchCall)));
    expect(h.dial).toHaveBeenCalledTimes(3);
    expect(await mongo.requests.countDocuments({ status: "dialed" })).toBe(3);
    expect(
      await mongo.requests.countDocuments({
        status: "failed",
        error: "daily_free_call_limit",
      }),
    ).toBe(7);
  });
  it("allows exactly 3 paid destination calls across concurrent dispatchers", async () => {
    await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        completedCheckout(`paid-${index}`, `payer-${index}@example.com`, 50),
      ),
    );
    await Promise.all(Array.from({ length: 10 }, () => h.run(dispatchCall)));
    expect(h.dial).toHaveBeenCalledTimes(3);
    expect(await mongo.requests.countDocuments({ status: "dialed" })).toBe(3);
    expect(
      await mongo.requests.countDocuments({
        status: "failed",
        error: "daily_call_limit",
      }),
    ).toBe(7);
    expect(await mongo.purchases.countDocuments()).toBe(10);
  });
  it("clears destination usage without rebuilding from Mongo call history", async () => {
    for (let index = 0; index < 3; index++) {
      await completedCheckout(`before-${index}`, "payer@example.com", 50);
      await h.run(dispatchCall);
    }
    await expect(
      Effect.runPromise(destinationLimit.check(input.to)),
    ).rejects.toThrow("3 calls");
    await clearQuota();
    await expect(
      Effect.runPromise(destinationLimit.check(input.to)),
    ).resolves.toBeUndefined();
    expect(await mongo.requests.countDocuments({ status: "dialed" })).toBe(3);
    expect(await mongo.purchases.countDocuments()).toBe(3);
    await completedCheckout("after-reset", "payer@example.com", 50);
    await h.run(dispatchCall);
    expect(h.dial).toHaveBeenCalledTimes(4);
    expect(await mongo.requests.countDocuments({ status: "dialed" })).toBe(4);
  });
  it("retains both completed quotas if Mongo bookkeeping fails after dialing", async () => {
    await completedCheckout("bookkeeping-failure", "payer@example.com");
    const update = vi
      .spyOn(mongo.requests, "updateOne")
      .mockRejectedValueOnce(new Error("Mongo unavailable"));
    try {
      await h.run(dispatchCall);
      expect(h.dial).toHaveBeenCalledTimes(1);
      const dialedKeys = await redis.keys(`${prefix}*:dialed`);
      expect(dialedKeys).toHaveLength(2);
      for (const key of dialedKeys)
        expect(await redis.zcard(key.slice(prefix.length))).toBe(1);
    } finally {
      update.mockRestore();
    }
  });
  it.each(["preflight", "dial"])(
    "releases the Redis reservation when %s fails",
    async (failure) => {
      await completedCheckout("failed-free", "payer@example.com");
      if (failure === "preflight")
        h.check.mockReturnValueOnce(
          Effect.fail(new PreflightError({ code: "blocked_number" })),
        );
      else h.dial.mockRejectedValueOnce(new Error("Dial failed"));
      await h.run(dispatchCall);
      expect(
        (await mongo.requests.findOne({ _id: "failed-free" }))?.status,
      ).toBe("failed");
      for (let index = 0; index < 3; index++) {
        await completedCheckout(`free-${index}`, "payer@example.com");
        await h.run(dispatchCall);
      }
      expect(await mongo.requests.countDocuments({ status: "dialed" })).toBe(3);
      await completedCheckout("fourth", "payer@example.com");
      await h.run(dispatchCall);
      expect((await mongo.requests.findOne({ _id: "fourth" }))?.error).toBe(
        "daily_free_call_limit",
      );
    },
  );
  it("releases a free-call reservation on interruption", async () => {
    await completedCheckout("interrupted-free", "payer@example.com");
    let started!: () => void;
    const signal = new Promise<void>((resolve) => {
      started = resolve;
    });
    h.dial.mockImplementationOnce(() => {
      started();
      return new Promise(() => {});
    });
    const fiber = Effect.runFork(h.provide(dispatchCall));
    await signal;
    await Effect.runPromise(Fiber.interrupt(fiber));
    expect(
      (await mongo.requests.findOne({ _id: "interrupted-free" }))?.status,
    ).toBe("failed");
    expect(await redis.keys(`${prefix}*`)).toEqual([]);
  });
  it.each(["unpaid", "expired"] as const)(
    "does not dial a %s request after its Checkout deadline",
    async (status) => {
      await mongo.requests.insertOne(
        requestFixture({ status, expiresAt: new Date(0) }),
      );
      expect(await h.run(dispatchCall)).toBe(false);
      expect(h.dial).not.toHaveBeenCalled();
    },
  );
  it("claims a paid call once across concurrent consumers and repeated webhooks", async () => {
    const { result, session } = await h.paid();
    await Promise.all(Array.from({ length: 10 }, () => h.run(dispatchCall)));
    expect(h.dial).toHaveBeenCalledTimes(1);
    expect(h.dial.mock.calls[0]![0]).toMatchObject({
      ...input,
      maxDuration: MAX_DURATION,
      room: `call_${result.call_id}`,
    });
    await h.run(
      handleStripeEvent(event(session)).pipe(
        Effect.provideService(
          StripeClient,
          StripeClient.make({
            retrieveSession: () =>
              Effect.succeed({ accountId: "acct_test", session }),
            createSession: () =>
              Effect.dieMessage("Unexpected Checkout creation"),
            verifyEvent: () =>
              Effect.dieMessage("Unexpected signature verification"),
          }),
        ),
      ),
    );
    expect(await h.run(dispatchCall)).toBe(false);
    expect(
      (await h.run(readCallRequest(result.call_id, accessToken))).status,
    ).toBe("dialed");
  });
  it("does not redial an uncertain provider failure after restarting the consumer", async () => {
    const { result } = await h.paid();
    h.dial.mockRejectedValueOnce(new Error("provider accepted before timeout"));
    await h.run(dispatchCall);
    expect(
      (await h.run(readCallRequest(result.call_id, accessToken))).status,
    ).toBe("failed");
    expect(await h.run(dispatchCall)).toBe(false);
    expect(h.dial).toHaveBeenCalledTimes(1);
  });
  it("dials a tax-inclusive delayed Managed Payments purchase only after payment and only once", async () => {
    const record = requestFixture();
    await h.mongo.requests.insertOne(record);
    const session = sessionFixture({
      status: "complete",
      payment_status: "unpaid",
      managed_payments: { enabled: true },
      amount_subtotal: 50,
      amount_total: 50,
      total_details: { amount_tax: 3, amount_discount: 0, amount_shipping: 0 },
    });
    const receive = (type: string) =>
      h.run(
        handleStripeEvent(event(session, type)).pipe(
          Effect.provideService(
            StripeClient,
            StripeClient.make({
              retrieveSession: () =>
                Effect.succeed({ accountId: "acct_test", session }),
              createSession: () =>
                Effect.dieMessage("Unexpected Checkout creation"),
              verifyEvent: () =>
                Effect.dieMessage("Unexpected signature verification"),
            }),
          ),
        ),
      );
    await receive("checkout.session.completed");
    expect(await h.run(dispatchCall)).toBe(false);
    expect(h.dial).not.toHaveBeenCalled();

    session.payment_status = "paid";
    await receive("checkout.session.async_payment_succeeded");
    await h.run(dispatchCall);
    await receive("checkout.session.async_payment_succeeded");
    expect(await h.run(dispatchCall)).toBe(false);
    expect(h.dial).toHaveBeenCalledTimes(1);
    expect((await h.run(readCallRequest(record._id, accessToken))).status).toBe(
      "dialed",
    );
  });
  it("recovers a stale claim without redialing and leaves fresh claims alone", async () => {
    const { result } = await h.paid();
    await h.mongo.requests.updateOne(
      { _id: result.call_id },
      { $set: { status: "dialing", claimedAt: new Date() } },
    );
    await h.run(dispatchCall);
    expect(
      (await h.run(readCallRequest(result.call_id, accessToken))).status,
    ).toBe("dialing");
    await h.mongo.requests.updateOne(
      { _id: result.call_id },
      { $set: { claimedAt: new Date(Date.now() - 180_000) } },
    );
    await h.run(dispatchCall);
    expect(
      (await h.run(readCallRequest(result.call_id, accessToken))).status,
    ).toBe("failed");
    expect(h.dial).not.toHaveBeenCalled();
  });
  it("does not redial when dialing succeeds but saving the outcome fails", async () => {
    const { result } = await h.paid();
    const update = vi
      .spyOn(h.mongo.requests, "updateOne")
      .mockRejectedValueOnce(new Error("write failed"));
    await h.run(dispatchCall);
    update.mockRestore();
    expect(
      (await h.run(readCallRequest(result.call_id, accessToken))).status,
    ).toBe("failed");
    expect(await h.run(dispatchCall)).toBe(false);
    expect(h.dial).toHaveBeenCalledTimes(1);
  });
  it.each([
    { to: "+15550000000" },
    { amount: 1 },
    { currency: "eur" },
    { purchaseId: "missing" },
  ])("refuses a mutated or missing paid request %j", async (change) => {
    const { result } = await h.paid();
    await h.mongo.requests.updateOne({ _id: result.call_id }, { $set: change });
    await h.run(dispatchCall);
    expect(h.dial).not.toHaveBeenCalled();
    expect(
      (await h.run(readCallRequest(result.call_id, accessToken))).error,
    ).toBe("conflict");
  });
  it.each([
    { stripeAccountId: "other" },
    { livemode: false },
    { amountTotal: 100 },
    { currency: "eur" },
    { requestId: "other" },
    { checkoutSessionId: "other" },
  ])("checks the purchase binding %j", async (change) => {
    await h.paid();
    await h.mongo.purchases.updateOne({}, { $set: change });
    await h.run(dispatchCall);
    expect(h.dial).not.toHaveBeenCalled();
  });
  it("dials development requests only while running in development", async () => {
    const { result } = await h.paid({ environment: "development" });
    expect(await h.run(dispatchCall)).toBe(false);
    await h.run(dispatchCall, { environment: "development" });
    expect(
      (await h.run(readCallRequest(result.call_id, accessToken))).status,
    ).toBe("dialed");
    expect(h.dial).toHaveBeenCalledTimes(1);
  });
  it("never dials a development request funded by a live payment", async () => {
    const { result } = await h.paid({ environment: "development" });
    await h.mongo.requests.updateOne(
      {},
      { $set: { "checkout.livemode": true } },
    );
    await h.mongo.purchases.updateOne({}, { $set: { livemode: true } });
    await h.run(dispatchCall, { environment: "development" });
    expect(h.dial).not.toHaveBeenCalled();
    expect(
      (await h.run(readCallRequest(result.call_id, accessToken))).error,
    ).toBe("conflict");
  });
  it("never dials a production request funded by a Sandbox payment", async () => {
    const { result } = await h.paid();
    await h.mongo.requests.updateOne(
      {},
      { $set: { "checkout.livemode": false } },
    );
    await h.mongo.purchases.updateOne({}, { $set: { livemode: false } });
    await h.run(dispatchCall);
    expect(h.dial).not.toHaveBeenCalled();
    expect(
      (await h.run(readCallRequest(result.call_id, accessToken))).error,
    ).toBe("conflict");
  });
  it("does not recover stale production claims while running in development", async () => {
    const { result } = await h.paid();
    await h.mongo.requests.updateOne(
      {},
      {
        $set: {
          status: "dialing",
          claimedAt: new Date(Date.now() - 180_000),
        },
      },
    );
    await h.run(dispatchCall, { environment: "development" });
    expect(
      (await h.run(readCallRequest(result.call_id, accessToken))).status,
    ).toBe("dialing");
    expect(h.dial).not.toHaveBeenCalled();
  });
});
