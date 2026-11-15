import { createHash, randomUUID } from "node:crypto";
import { Effect } from "effect";
import { Redis } from "ioredis";
import { MongoClient as Driver } from "mongodb";
import type Stripe from "stripe";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  MongoClient,
  createRequestIndexes,
  type PurchaseDoc,
  type RequestDoc,
} from "../clients/mongo.js";
import { RedisClient } from "../clients/redis.js";
import { LiveKitClient } from "../clients/livekit.js";
import { StripeClient } from "../clients/stripe.js";
import { PaymentConfig } from "../handlers/payments/config.js";
import { createCallRequest } from "../handlers/payments/http.js";
import { requestSnapshotHash } from "../handlers/payments/schema.js";
import { dispatchCall } from "../pipeline/dispatch.js";
import { handleStripeEvent } from "../webhooks/stripe.js";
import { CallLimit, makeCallLimit, makeFreeCallLimit } from "./limit.js";
import { Preflight, makePreflight } from "./preflight.js";

const mongoUri = process.env.MONGODB_URI;
const redisUrl = process.env.REDIS_URL;
const DAY = 86_400_000;
const email = "payer@example.com";
const number = "+14155552671";
const otherNumber = "+14155552672";
const settings = PaymentConfig.make({
  amount: 50,
  currency: "usd",
  publicApiUrl: "http://localhost:3001",
  publicWebUrl: "http://localhost:3000",
  environment: "production",
});

describe.skipIf(!mongoUri || !redisUrl)("Redis destination call limit", () => {
  const driver = new Driver(mongoUri ?? "mongodb://127.0.0.1:27017");
  const db = driver.db(
    `ringback_limit_test_${randomUUID().replaceAll("-", "")}`,
  );
  const mongo = {
    requests: db.collection<RequestDoc>("requests"),
    purchases: db.collection<PurchaseDoc>("purchases"),
  };
  const redisPrefix = `test:${randomUUID()}:`;
  const redis = new Redis(redisUrl ?? "redis://localhost:6379", {
    keyPrefix: redisPrefix,
    lazyConnect: true,
    maxRetriesPerRequest: 1,
  });
  const limit = makeCallLimit(redis, mongo.requests, "production");
  const lookup = vi.fn((to: string) =>
    Effect.succeed({
      number: to,
      valid: true,
      country: "US",
      lineType: "mobile" as const,
      lineTypeError: null,
      checkedAt: Date.now(),
      expiresAt: Date.now() + DAY,
    }),
  );
  const dial = vi.fn(() => Effect.void);
  const stripe = StripeClient.make({
    createSession: () =>
      Effect.dieMessage("Rejected calls must not create Checkout"),
    retrieveSession: () => Effect.dieMessage("Unexpected Stripe retrieval"),
    verifyEvent: () => Effect.dieMessage("Unexpected signature verification"),
  });
  const run = <A, E>(
    effect: Effect.Effect<
      A,
      E,
      | MongoClient
      | RedisClient
      | LiveKitClient
      | PaymentConfig
      | Preflight
      | CallLimit
      | StripeClient
    >,
  ) =>
    Effect.runPromise(
      effect.pipe(
        Effect.provideService(MongoClient, mongo as MongoClient),
        Effect.provideService(RedisClient, redis as unknown as RedisClient),
        Effect.provideService(
          LiveKitClient,
          LiveKitClient.make({ ready: Effect.void, dial }),
        ),
        Effect.provideService(PaymentConfig, settings),
        Effect.provideService(
          Preflight,
          Preflight.make(makePreflight(lookup, undefined, limit.check)),
        ),
        Effect.provideService(CallLimit, CallLimit.make(limit)),
        Effect.provideService(StripeClient, stripe),
      ),
    );
  const clearRedis = async () => {
    const keys = await redis.keys(`${redisPrefix}*`);
    if (keys.length)
      await redis.del(...keys.map((key) => key.slice(redisPrefix.length)));
  };

  beforeAll(async () => {
    await Promise.all([driver.connect(), redis.connect()]);
    await createRequestIndexes(mongo.requests);
  });
  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    await Promise.all([
      mongo.requests.deleteMany({}),
      mongo.purchases.deleteMany({}),
      clearRedis(),
    ]);
  });
  afterAll(async () => {
    try {
      await Promise.all([db.dropDatabase(), clearRedis()]);
    } finally {
      await Promise.all([driver.close(), redis.quit()]);
    }
  });

  const seed = async (
    id: string,
    changes: Partial<RequestDoc> = {},
    total = 50,
  ) => {
    const record: RequestDoc = {
      _id: id,
      to: number,
      prompt: "Ask about opening hours.",
      amount: 50,
      currency: "usd",
      maxDuration: 120,
      terms: { version: "2026-10-30", url: "https://example.com/terms" },
      privacy: { version: "2026-10-30", url: "https://example.com/privacy" },
      environment: "production",
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + DAY),
      access: { tokenHash: "test", expiresAt: new Date(Date.now() + DAY) },
      dashboardUrl: `https://example.com/call/${id}`,
      inputHash: "test",
      requestSnapshotHash: "",
      status: "paid",
      room: `call_${id}`,
      purchaseId: `purchase_${id}`,
      checkout: {
        id: `cs_${id}`,
        url: "https://checkout.stripe.com/test",
        accountId: "acct_test",
        livemode: true,
      },
      ...changes,
    };
    record.requestSnapshotHash = requestSnapshotHash(record);
    await mongo.requests.insertOne(record);
    await mongo.purchases.insertOne({
      _id: record.purchaseId!,
      requestId: id,
      stripeAccountId: record.checkout!.accountId,
      livemode: true,
      checkoutSessionId: record.checkout!.id,
      paymentIntentId: total === 0 ? null : `pi_${id}`,
      // Use distinct payers to isolate the destination limit from the free-call limit.
      customer: {
        stripeId: "cus_test",
        name: null,
        email: `${id}@example.com`,
        phone: null,
      },
      amountSubtotal: 50,
      amountTotal: total,
      currency: "usd",
      recordedAt: new Date(),
      terms: record.terms,
      privacy: record.privacy,
    });
    return record;
  };

  it("allows the first three paid/free calls, then rejects creation before Checkout", async () => {
    for (let i = 0; i < 3; i++) {
      await run(limit.check(number));
      await seed(`call-${i}`, { status: "dialed" }, i === 1 ? 0 : 50);
      await run(limit.invalidate);
    }
    const error = await run(
      createCallRequest({
        to: number,
        prompt: "Ask about opening hours.",
      }).pipe(Effect.flip),
    );
    expect(error).toMatchObject({ code: "daily_call_limit" });
    expect(await mongo.requests.countDocuments()).toBe(3);
    expect(lookup).not.toHaveBeenCalled();
  });

  it.each([0, 50])(
    "dials three %s-cent purchases once, then rejects the fourth at dispatch",
    async (total) => {
      for (let i = 0; i < 4; i++) {
        await seed(`call-${i}`, {}, total);
        await run(dispatchCall);
      }
      expect(dial).toHaveBeenCalledTimes(3);
      expect(await mongo.requests.findOne({ _id: "call-3" })).toMatchObject({
        status: "failed",
        error: "daily_call_limit",
      });
      expect(await run(dispatchCall)).toBe(false);
      await expect(run(limit.check(number))).rejects.toThrow(
        "3 calls in the last 24 hours",
      );
    },
  );

  it("counts paid, dialing and dialed requests but excludes the current request", async () => {
    await seed("paid", { status: "paid" });
    await seed("dialing", { status: "dialing", claimedAt: new Date() });
    await seed("dialed", { status: "dialed" });
    await expect(run(limit.check(number))).rejects.toThrow("3 calls");
    await expect(run(limit.check(number, "dialing"))).resolves.toBeUndefined();
    await expect(run(limit.check(number, "not-in-the-window"))).rejects.toThrow(
      "3 calls",
    );
  });

  it("ignores unpaid, expired, failed, other destinations and other environments", async () => {
    for (const status of ["unpaid", "expired", "failed"] as const) {
      await seed(status, { status });
    }
    await seed("other-number", { to: otherNumber });
    await seed("other-env", { environment: "development" });
    await seed("paid");
    await seed("dialed", { status: "dialed" });
    await expect(run(limit.check(number))).resolves.toBeUndefined();
  });

  it("expires entries exactly 24 hours after creation, including cached entries", async () => {
    const now = Date.now();
    await seed("old", { createdAt: new Date(now - DAY - 1) });
    await seed("recent", { createdAt: new Date(now - DAY + 10_000) });
    await seed("second");
    await seed("third");
    vi.spyOn(Date, "now").mockReturnValue(now);
    await expect(run(limit.check(number))).rejects.toThrow("3 calls");
    const find = vi.spyOn(mongo.requests, "find");
    vi.mocked(Date.now).mockReturnValue(now + 10_000);
    await expect(run(limit.check(number))).resolves.toBeUndefined();
    expect(find).not.toHaveBeenCalled();
  });

  it("rebuilds from Mongo after cache loss and releases failed/stale dispatch claims", async () => {
    await seed("first", { status: "dialed" });
    await seed("second", { status: "dialed" });
    await seed("stale", {
      status: "dialing",
      claimedAt: new Date(Date.now() - 180_000),
    });
    await expect(run(limit.check(number))).rejects.toThrow("3 calls");
    await clearRedis();
    await expect(run(limit.check(number))).rejects.toThrow("3 calls");
    await run(dispatchCall);
    await expect(run(limit.check(number))).resolves.toBeUndefined();
  });

  it("invalidates a cached unpaid count when a free Stripe checkout completes, including replays", async () => {
    await seed("first", { status: "dialed" });
    await seed("second", { status: "dialed" });
    const record = await seed("third", { status: "unpaid" }, 0);
    await run(limit.check(number));
    const session = {
      id: record.checkout!.id,
      object: "checkout.session",
      mode: "payment",
      status: "complete",
      payment_status: "paid",
      livemode: true,
      client_reference_id: record._id,
      amount_subtotal: 50,
      amount_total: 0,
      currency: "usd",
      customer: "cus_test",
      payment_intent: null,
      consent: { terms_of_service: "accepted", promotions: null },
      customer_details: {
        address: null,
        business_name: null,
        email: "payer@example.com",
        individual_name: null,
        name: null,
        phone: null,
        tax_exempt: null,
        tax_ids: null,
      },
      metadata: {
        request_snapshot_hash: record.requestSnapshotHash,
        terms_version: record.terms.version,
        terms_url: record.terms.url,
        privacy_version: record.privacy.version,
        privacy_url: record.privacy.url,
      },
    } as Partial<Stripe.Checkout.Session> as Stripe.Checkout.Session;
    const event = {
      id: "evt_test",
      type: "checkout.session.completed",
      livemode: true,
      data: { object: session },
    } as Stripe.Event;
    const receive = () =>
      run(
        handleStripeEvent(event).pipe(
          Effect.provideService(
            StripeClient,
            StripeClient.make({
              ...stripe,
              retrieveSession: () =>
                Effect.succeed({ accountId: "acct_test", session }),
            }),
          ),
        ),
      );
    await receive();
    await expect(run(limit.check(number))).rejects.toThrow("3 calls");
    await receive();
    await expect(run(limit.check(number, "third"))).resolves.toBeUndefined();
  });

  it("retries a snapshot invalidated during its Mongo read", async () => {
    const originalFind = mongo.requests.find.bind(mongo.requests);
    const find = vi
      .spyOn(mongo.requests, "find")
      .mockImplementationOnce((...args) => {
        const cursor = originalFind(...args);
        const toArray = cursor.toArray.bind(cursor);
        vi.spyOn(cursor, "toArray").mockImplementationOnce(async () => {
          const stale = await toArray();
          await seed("first");
          await seed("second");
          await seed("third");
          await run(limit.invalidate);
          return stale;
        });
        return cursor;
      });
    await expect(run(limit.check(number))).rejects.toThrow("3 calls");
    expect(find).toHaveBeenCalledTimes(2);
  });

  it("fails closed when Redis cannot be read", async () => {
    vi.spyOn(redis, "mget").mockRejectedValueOnce(
      new Error("Redis unavailable"),
    );
    expect(await run(limit.check(number).pipe(Effect.flip))).toMatchObject({
      code: "call_limit_unavailable",
    });
  });
});

describe("free-call quota failures", () => {
  it("fails closed when Redis rejects the reservation", async () => {
    const limit = makeFreeCallLimit(
      {
        eval: vi.fn(async () => {
          throw new Error("Redis unavailable");
        }),
      },
      "production",
    );
    expect(
      await Effect.runPromise(Effect.flip(limit.reserve(email, "request"))),
    ).toMatchObject({ code: "free_call_limit_unavailable" });
  });
  it("bounds a Redis command that never responds", async () => {
    vi.useFakeTimers();
    try {
      const limit = makeFreeCallLimit(
        { eval: vi.fn(() => new Promise(() => {})) },
        "production",
      );
      const pending = Effect.runPromise(
        Effect.flip(limit.reserve(email, "request")),
      );
      await vi.advanceTimersByTimeAsync(3100);
      expect(await pending).toMatchObject({
        code: "free_call_limit_unavailable",
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe.skipIf(!redisUrl)("Redis free-call quota", () => {
  const prefix = `test:${randomUUID()}:`;
  const redis = new Redis(redisUrl ?? "redis://127.0.0.1:6379", {
    keyPrefix: prefix,
    lazyConnect: true,
    maxRetriesPerRequest: 1,
  });
  const limit = makeFreeCallLimit(redis, "production");
  const run = Effect.runPromise;
  const clear = async () => {
    const keys = await redis.keys(`${prefix}*`);
    if (keys.length)
      await redis.del(...keys.map((key) => key.slice(prefix.length)));
  };
  const keys = (identity = email, environment = "production") => {
    const digest = createHash("sha256").update(identity).digest("hex");
    const base = `free-call-limit:${environment}:{${digest}}`;
    return { pending: `${base}:pending`, dialed: `${base}:dialed` };
  };
  const now = async () => {
    const [seconds, microseconds] = await redis.time();
    return Number(seconds) * 1000 + Math.floor(Number(microseconds) / 1000);
  };
  beforeAll(async () => {
    await redis.connect();
  });
  beforeEach(clear);
  afterAll(async () => {
    try {
      await clear();
    } finally {
      await redis.quit();
    }
  });

  it("allows 3 free calls and refuses the fourth", async () => {
    for (let index = 0; index < 3; index++) {
      await run(limit.reserve(email, `request-${index}`));
      await run(limit.complete(email, `request-${index}`));
    }
    await expect(run(limit.reserve(email, "fourth"))).rejects.toThrow(
      "daily_free_call_limit",
    );
    expect(await redis.zcard(keys().dialed)).toBe(3);
  });

  it("atomically admits only 3 concurrent reservations", async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        run(Effect.either(limit.reserve(email, `request-${index}`))),
      ),
    );
    expect(results.filter((result) => result._tag === "Right")).toHaveLength(3);
    expect(results.filter((result) => result._tag === "Left")).toHaveLength(17);
    expect(await redis.zcard(keys().pending)).toBe(3);
  });

  it("does not consume extra slots or extend timestamps when repeated", async () => {
    await run(limit.reserve(email, "first"));
    const reservedAt = await redis.zscore(keys().pending, "first");
    await run(limit.reserve(email, "first"));
    expect(await redis.zscore(keys().pending, "first")).toBe(reservedAt);
    await run(limit.complete(email, "first"));
    const completedAt = await redis.zscore(keys().dialed, "first");
    await run(limit.reserve(email, "first"));
    await run(limit.complete(email, "first"));
    expect(await redis.zscore(keys().dialed, "first")).toBe(completedAt);
    await run(limit.reserve(email, "second"));
    await run(limit.reserve(email, "third"));
    await expect(run(limit.reserve(email, "fourth"))).rejects.toThrow(
      "daily_free_call_limit",
    );
  });

  it("uses a rolling 24-hour window, expiring boundary entries while retaining recent calls", async () => {
    const timestamp = await now();
    await redis.zadd(
      keys().dialed,
      timestamp - DAY,
      "boundary",
      timestamp - DAY - 1,
      "older",
      timestamp - 60_000,
      "recent-1",
      timestamp - 120_000,
      "recent-2",
    );
    await redis.pexpire(keys().dialed, DAY);
    await run(limit.reserve(email, "third"));
    expect(await redis.zrange(keys().dialed, 0, -1)).toEqual([
      "recent-2",
      "recent-1",
    ]);
    await expect(run(limit.reserve(email, "fourth"))).rejects.toThrow(
      "daily_free_call_limit",
    );
  });

  it("expires pending keys after 2 minutes and completed keys after 24 hours", async () => {
    await run(limit.reserve(email, "request"));
    expect(await redis.pttl(keys().pending)).toBeGreaterThan(115_000);
    expect(await redis.pttl(keys().pending)).toBeLessThanOrEqual(120_000);
    await run(limit.complete(email, "request"));
    expect(await redis.exists(keys().pending)).toBe(0);
    expect(await redis.pttl(keys().dialed)).toBeGreaterThan(DAY - 5000);
    expect(await redis.pttl(keys().dialed)).toBeLessThanOrEqual(DAY);
    expect(
      (await redis.keys(`${prefix}*`)).every((key) => !key.includes(email)),
    ).toBe(true);
  });

  it("releases abandoned reservations after the dispatch claim expires", async () => {
    const timestamp = await now();
    await redis.zadd(
      keys().pending,
      timestamp - 120_000,
      "stale-1",
      timestamp - 120_001,
      "stale-2",
      timestamp - 120_002,
      "stale-3",
    );
    await redis.pexpire(keys().pending, 120_000);
    await run(limit.reserve(email, "fresh"));
    expect(await redis.zrange(keys().pending, 0, -1)).toEqual(["fresh"]);
  });

  it("keeps different identities and environments separate", async () => {
    const development = makeFreeCallLimit(redis, "development");
    for (let index = 0; index < 3; index++) {
      await run(limit.reserve(email, `prod-${index}`));
      await run(limit.reserve("other@example.com", `other-${index}`));
      await run(development.reserve(email, `dev-${index}`));
    }
    await expect(run(limit.reserve(email, "fourth"))).rejects.toThrow(
      "daily_free_call_limit",
    );
    await expect(
      run(limit.reserve("other@example.com", "fourth")),
    ).rejects.toThrow("daily_free_call_limit");
    await expect(run(development.reserve(email, "fourth"))).rejects.toThrow(
      "daily_free_call_limit",
    );
  });

  it("releases failed requests idempotently and removes empty keys", async () => {
    await run(limit.reserve(email, "completed"));
    await run(limit.complete(email, "completed"));
    await run(limit.reserve(email, "pending"));
    for (let attempt = 0; attempt < 2; attempt++) {
      await run(limit.release(email, "completed"));
      await run(limit.release(email, "pending"));
    }
    expect(await redis.keys(`${prefix}*`)).toEqual([]);
    await run(limit.reserve(email, "next"));
  });

  it("requires a reservation before recording a completed call", async () => {
    await expect(run(limit.complete(email, "unreserved"))).rejects.toThrow(
      "free_call_limit_unavailable",
    );
    expect(await redis.keys(`${prefix}*`)).toEqual([]);
  });
});
