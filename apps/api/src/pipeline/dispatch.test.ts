import { randomUUID } from "node:crypto";
import { MongoClient as Driver } from "mongodb";
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
import { handleStripeEvent } from "../webhooks/stripe.js";

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
  requireTerms: false,
};
type Settings = Omit<PaymentConfig, "_tag">;
const mongoUri = process.env.MONGODB_URI;
const requestFixture = (changes: Partial<RequestDoc> = {}): RequestDoc => {
  const record = {
    _id: "request-test",
    ...input,
    inputHash: hash(input),
    ...settings,
    maxDuration: MAX_DURATION,
    policyVersion: "prompt-rules-v1",
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 35 * 60_000),
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
    livemode: true,
    client_reference_id: "request-test",
    amount_total: 50,
    currency: "usd",
    metadata: { request_snapshot_hash: requestFixture().requestSnapshotHash },
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
  customer: { stripeId: "cus_test", name: null, email: null, phone: null },
  amountTotal: 50,
  currency: "usd",
  recordedAt: new Date(),
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
const harness = (
  mongo:
    | Pick<MongoClient, "requests" | "purchases">
    | ReturnType<typeof fakeMongo> = fakeMongo(),
) => {
  const ready = vi.fn(async () => {});
  const dial = vi.fn<(request: DialInput) => Promise<void>>(async () => {});
  const dialer = LiveKitClient.make({
    ready: Effect.promise(() => ready()),
    dial: (request) =>
      Effect.tryPromise({
        try: () => dial(request),
        catch: () => new LiveKitError({ code: "unavailable" }),
      }),
  });
  const provide = <A, E, R>(
    effect: Effect.Effect<A, E, R>,
    overrides: Partial<Settings> = {},
  ) =>
    effect.pipe(
      Effect.provideService(MongoClient, mongo as MongoClient),
      Effect.provideService(LiveKitClient, dialer),
      Effect.provideService(
        PaymentConfig,
        PaymentConfig.make({ ...settings, ...overrides }),
      ),
    );
  return {
    ready,
    dial,
    provide,
    run: <A, E>(
      effect: Effect.Effect<A, E, MongoClient | LiveKitClient | PaymentConfig>,
      overrides: Partial<Settings> = {},
    ) => Effect.runPromise(provide(effect, overrides)),
  };
};

describe("paid dispatch", () => {
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

describe.skipIf(!mongoUri)("dispatch persistence", () => {
  const driver = new Driver(mongoUri ?? "mongodb://127.0.0.1:27017", {
    serverSelectionTimeoutMS: 3000,
  });
  const db = driver.db(`ringback_test_${randomUUID().replaceAll("-", "")}`);
  const mongo = {
    requests: db.collection<RequestDoc>("requests"),
    purchases: db.collection<PurchaseDoc>("purchases"),
  };
  beforeAll(async () => {
    await driver.connect();
    await Promise.all([
      createRequestIndexes(mongo.requests),
      createPurchaseIndexes(mongo.purchases),
    ]);
  });
  beforeEach(async () => {
    await Promise.all(
      Object.values(mongo).map((collection) => collection.deleteMany({})),
    );
    vi.clearAllMocks();
  });
  afterAll(async () => {
    try {
      await db.dropDatabase();
    } finally {
      await driver.close();
    }
  });
  const h = {
    ...harness(mongo),
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
        metadata: { request_snapshot_hash: record.requestSnapshotHash },
      });
      return { result: { call_id: record._id }, session };
    },
  };
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
    expect((await h.run(readCallRequest(result.call_id))).status).toBe(
      "dialed",
    );
  });
  it("does not redial an uncertain provider failure after restarting the consumer", async () => {
    const { result } = await h.paid();
    h.dial.mockRejectedValueOnce(new Error("provider accepted before timeout"));
    await h.run(dispatchCall);
    expect((await h.run(readCallRequest(result.call_id))).status).toBe(
      "failed",
    );
    expect(await h.run(dispatchCall)).toBe(false);
    expect(h.dial).toHaveBeenCalledTimes(1);
  });
  it("recovers a stale claim without redialing and leaves fresh claims alone", async () => {
    const { result } = await h.paid();
    await h.mongo.requests.updateOne(
      { _id: result.call_id },
      { $set: { status: "dialing", claimedAt: new Date() } },
    );
    await h.run(dispatchCall);
    expect((await h.run(readCallRequest(result.call_id))).status).toBe(
      "dialing",
    );
    await h.mongo.requests.updateOne(
      { _id: result.call_id },
      { $set: { claimedAt: new Date(Date.now() - 180_000) } },
    );
    await h.run(dispatchCall);
    expect((await h.run(readCallRequest(result.call_id))).status).toBe(
      "failed",
    );
    expect(h.dial).not.toHaveBeenCalled();
  });
  it("does not redial when dialing succeeds but saving the outcome fails", async () => {
    const { result } = await h.paid();
    const update = vi
      .spyOn(h.mongo.requests, "updateOne")
      .mockRejectedValueOnce(new Error("write failed"));
    await h.run(dispatchCall);
    update.mockRestore();
    expect((await h.run(readCallRequest(result.call_id))).status).toBe(
      "failed",
    );
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
    expect((await h.run(readCallRequest(result.call_id))).error).toBe(
      "conflict",
    );
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
    expect((await h.run(readCallRequest(result.call_id))).status).toBe(
      "dialed",
    );
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
    expect((await h.run(readCallRequest(result.call_id))).error).toBe(
      "conflict",
    );
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
    expect((await h.run(readCallRequest(result.call_id))).error).toBe(
      "conflict",
    );
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
    expect((await h.run(readCallRequest(result.call_id))).status).toBe(
      "dialing",
    );
    expect(h.dial).not.toHaveBeenCalled();
  });
});
