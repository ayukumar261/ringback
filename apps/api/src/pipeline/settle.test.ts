import { randomUUID } from "node:crypto";
import { Effect, Layer, PubSub } from "effect";
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
  type CallDoc,
  type PurchaseDoc,
  type RequestDoc,
} from "../clients/mongo.js";
import { StripeClient, StripeError } from "../clients/stripe.js";
import type { CallEvent } from "../events/index.js";
import { PaymentConfig } from "../handlers/payments/config.js";
import { CallFeed } from "./feed.js";
import {
  RELEASE_AFTER_MS,
  SettleLive,
  settleCall,
  settlePayment,
  sweepPayments,
} from "./settle.js";

const intent = (status: Stripe.PaymentIntent.Status, id = "pi_test") =>
  ({ id, object: "payment_intent", status }) as Stripe.PaymentIntent;
const requestFixture = (changes: Partial<RequestDoc> = {}): RequestDoc => ({
  _id: "request-test",
  inputHash: "input",
  requestSnapshotHash: "snapshot",
  to: "+15551234567",
  prompt: "Ask for a flight price.",
  amount: 50,
  currency: "usd",
  maxDuration: 1800,
  terms: { version: "2026-10-30", url: "https://example.com/terms" },
  privacy: { version: "2026-10-30", url: "https://example.com/privacy" },
  environment: "production",
  createdAt: new Date(Date.now() - 10 * 60_000),
  expiresAt: new Date(Date.now() + 50 * 60_000),
  access: { tokenHash: "token", expiresAt: new Date(Date.now() + 60_000) },
  dashboardUrl: "https://example.com/call/request-test",
  status: "dialed",
  room: "call_request-test",
  purchaseId: "acct_test:live:cs_test",
  payment: { status: "held", heldAt: new Date(Date.now() - 2 * 60_000) },
  claimedAt: new Date(Date.now() - 60_000),
  dialedAt: new Date(Date.now() - 60_000),
  ...changes,
});
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
  recordedAt: new Date(Date.now() - 2 * 60_000),
  terms: { version: "2026-10-30", url: "https://example.com/terms" },
  privacy: { version: "2026-10-30", url: "https://example.com/privacy" },
  ...changes,
});

const fakeStripe = () => {
  type Call = (intentId: string) => Promise<Stripe.PaymentIntent>;
  const capture = vi.fn<Call>(async (id) => intent("succeeded", id));
  const release = vi.fn<Call>(async (id) => intent("canceled", id));
  const retrieve = vi.fn<Call>(async (id) => intent("requires_capture", id));
  const call = (fn: Call) => (intentId: string) =>
    Effect.tryPromise({
      try: () => fn(intentId),
      catch: () => new StripeError({ code: "unavailable" }),
    });
  return {
    capture,
    release,
    retrieve,
    client: StripeClient.make({
      capturePayment: call(capture),
      releasePayment: call(release),
      retrievePayment: call(retrieve),
      retrieveSession: () => Effect.dieMessage("Unexpected session lookup"),
      createSession: () => Effect.dieMessage("Unexpected Checkout creation"),
      verifyEvent: () => Effect.dieMessage("Unexpected verification"),
    }),
  };
};
const config = PaymentConfig.make({
  amount: 50,
  currency: "usd",
  publicApiUrl: "http://localhost:3001",
  publicWebUrl: "http://localhost:3000",
  environment: "production",
});
const run = <A, E>(
  effect: Effect.Effect<A, E, MongoClient | StripeClient | PaymentConfig>,
  mongo: unknown,
  stripe: ReturnType<typeof fakeStripe>,
) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provideService(MongoClient, mongo as MongoClient),
      Effect.provideService(StripeClient, stripe.client),
      Effect.provideService(PaymentConfig, config),
    ),
  );

describe("settle payment", () => {
  const fakeMongo = (record: RequestDoc | null = requestFixture()) => ({
    purchases: {
      findOne: vi.fn<() => Promise<PurchaseDoc | null>>(async () =>
        purchaseFixture(),
      ),
    },
    requests: {
      findOne: vi.fn(async () => record),
      updateOne: vi.fn(async () => ({ modifiedCount: 1 })),
    },
  });
  const settled = (status: string) => [
    { _id: "request-test", "payment.status": "held" },
    {
      $set: {
        "payment.status": status,
        "payment.settledAt": expect.any(Date),
      },
    },
  ];

  it("charges the hold once, under the request's capture key", async () => {
    const mongo = fakeMongo();
    const stripe = fakeStripe();
    expect(
      await run(settlePayment(requestFixture(), "charge"), mongo, stripe),
    ).toBe("charged");
    expect(stripe.capture).toHaveBeenCalledWith("pi_test");
    expect(stripe.release).not.toHaveBeenCalled();
    expect(mongo.requests.updateOne).toHaveBeenCalledWith(
      ...settled("charged"),
    );
  });
  it("releases the hold", async () => {
    const mongo = fakeMongo();
    const stripe = fakeStripe();
    expect(
      await run(settlePayment(requestFixture(), "release"), mongo, stripe),
    ).toBe("released");
    expect(stripe.release).toHaveBeenCalledWith("pi_test");
    expect(stripe.capture).not.toHaveBeenCalled();
    expect(mongo.requests.updateOne).toHaveBeenCalledWith(
      ...settled("released"),
    );
  });
  it.each([
    ["already charged", { status: "charged", heldAt: new Date() }],
    ["already released", { status: "released", heldAt: new Date() }],
    ["paid before holds", undefined],
  ] as const)("leaves a payment %s alone", async (_, payment) => {
    const mongo = fakeMongo();
    const stripe = fakeStripe();
    expect(
      await run(
        settlePayment(requestFixture({ payment }), "release"),
        mongo,
        stripe,
      ),
    ).toBeNull();
    expect(stripe.release).not.toHaveBeenCalled();
    expect(mongo.requests.updateOne).not.toHaveBeenCalled();
  });
  it("records a capture that succeeded before a retry", async () => {
    const mongo = fakeMongo();
    const stripe = fakeStripe();
    stripe.capture.mockRejectedValueOnce(new Error("already captured"));
    stripe.retrieve.mockResolvedValueOnce(intent("succeeded"));
    expect(
      await run(settlePayment(requestFixture(), "charge"), mongo, stripe),
    ).toBe("charged");
    expect(stripe.retrieve).toHaveBeenCalledWith("pi_test");
  });
  it("keeps the hold for a later retry when Stripe cannot settle it", async () => {
    const mongo = fakeMongo();
    const stripe = fakeStripe();
    stripe.capture.mockRejectedValueOnce(new Error("network"));
    await expect(
      run(settlePayment(requestFixture(), "charge"), mongo, stripe),
    ).rejects.toThrow("unavailable");
    expect(mongo.requests.updateOne).not.toHaveBeenCalled();
  });
  it("records a connected call whose hold had already lapsed as released", async () => {
    const mongo = fakeMongo();
    const stripe = fakeStripe();
    stripe.capture.mockRejectedValueOnce(new Error("canceled"));
    stripe.retrieve.mockResolvedValueOnce(intent("canceled"));
    expect(
      await run(settlePayment(requestFixture(), "charge"), mongo, stripe),
    ).toBe("released");
  });
  it("refuses a PaymentIntent other than the purchase's", async () => {
    const mongo = fakeMongo();
    const stripe = fakeStripe();
    stripe.capture.mockResolvedValueOnce(intent("succeeded", "pi_other"));
    await expect(
      run(settlePayment(requestFixture(), "charge"), mongo, stripe),
    ).rejects.toThrow("unavailable");
    expect(mongo.requests.updateOne).not.toHaveBeenCalled();
  });
  it.each([
    ["is missing", null],
    ["belongs to another request", purchaseFixture({ requestId: "other" })],
    ["is from the other Stripe mode", purchaseFixture({ livemode: false })],
  ])("refuses to settle when the purchase %s", async (_, purchase) => {
    const mongo = fakeMongo();
    mongo.purchases.findOne.mockResolvedValue(purchase);
    const stripe = fakeStripe();
    await expect(
      run(settlePayment(requestFixture(), "charge"), mongo, stripe),
    ).rejects.toThrow("conflict");
    expect(stripe.capture).not.toHaveBeenCalled();
  });
  it("finds a call's held payment by room in the current environment", async () => {
    const mongo = fakeMongo();
    const stripe = fakeStripe();
    expect(
      await run(settleCall("call_request-test", "charge"), mongo, stripe),
    ).toBe("charged");
    expect(mongo.requests.findOne).toHaveBeenCalledWith({
      "payment.status": "held",
      room: "call_request-test",
      environment: "production",
    });
  });
  it("ignores calls without a held payment, such as inbound calls", async () => {
    const mongo = fakeMongo(null);
    const stripe = fakeStripe();
    expect(
      await run(settleCall("call_inbound", "release"), mongo, stripe),
    ).toBeNull();
    expect(stripe.release).not.toHaveBeenCalled();
  });
});

const mongoUri = process.env.MONGODB_URI;

describe.skipIf(!mongoUri)("settle persistence", () => {
  const driver = new Driver(mongoUri ?? "mongodb://127.0.0.1:27017", {
    serverSelectionTimeoutMS: 3000,
  });
  const db = driver.db(`ringback_test_${randomUUID().replaceAll("-", "")}`);
  const mongo = {
    calls: db.collection<CallDoc>("calls"),
    purchases: db.collection<PurchaseDoc>("purchases"),
    requests: db.collection<RequestDoc>("requests"),
  };
  beforeAll(async () => {
    await driver.connect();
    await createRequestIndexes(mongo.requests);
  });
  beforeEach(async () => {
    await Promise.all(
      Object.values(mongo).map((collection) => collection.deleteMany({})),
    );
  });
  afterAll(async () => {
    try {
      await db.dropDatabase();
    } finally {
      await driver.close();
    }
  });
  const seed = async (
    id: string,
    changes: Partial<RequestDoc> = {},
    started = true,
  ) => {
    const purchaseId = `acct_test:live:cs_${id}`;
    await mongo.requests.insertOne(
      requestFixture({ _id: id, room: `call_${id}`, purchaseId, ...changes }),
    );
    await mongo.purchases.insertOne(
      purchaseFixture({
        _id: purchaseId,
        requestId: id,
        paymentIntentId: `pi_${id}`,
      }),
    );
    if (started)
      await mongo.calls.insertOne({
        room: `call_${id}`,
        status: "active",
        startedAt: new Date(),
      });
  };
  const payment = async (id: string) =>
    (await mongo.requests.findOne({ _id: id }))?.payment?.status;
  const sorted = (fn: { mock: { calls: unknown[][] } }) =>
    fn.mock.calls.map(([id]) => id).sort();

  describe("sweep", () => {
    it("charges held payments whose call started, once", async () => {
      await seed("dialed");
      await seed("failed", { status: "failed", error: "unavailable" });
      await seed("paid", { status: "paid" });
      await seed("dialing", { status: "dialing" });
      await seed("charged", {
        payment: {
          status: "charged",
          heldAt: new Date(),
          settledAt: new Date(),
        },
      });
      await seed("development", { environment: "development" });
      const stripe = fakeStripe();
      await run(sweepPayments, mongo, stripe);
      await run(sweepPayments, mongo, stripe);
      expect(sorted(stripe.capture)).toEqual(["pi_dialed", "pi_failed"]);
      expect(await payment("dialed")).toBe("charged");
      expect(await payment("failed")).toBe("charged");
      expect(await payment("paid")).toBe("held");
      expect(await payment("dialing")).toBe("held");
      expect(await payment("development")).toBe("held");
      expect(
        (await mongo.requests.findOne({ _id: "dialed" }))?.payment?.settledAt,
      ).toBeInstanceOf(Date);
    });
    it("releases holds only once their call can no longer start", async () => {
      const due = new Date(Date.now() - RELEASE_AFTER_MS - 1);
      await seed("due", { claimedAt: due }, false);
      await seed("due-failed", { status: "failed", claimedAt: due }, false);
      await seed("ringing", {}, false);
      const stripe = fakeStripe();
      await run(sweepPayments, mongo, stripe);
      expect(sorted(stripe.release)).toEqual(["pi_due", "pi_due-failed"]);
      expect(await payment("due")).toBe("released");
      expect(await payment("ringing")).toBe("held");
    });
    it("keeps settling other holds when one fails", async () => {
      await seed("first", { claimedAt: new Date(Date.now() - 2 * 60_000) });
      await seed("second");
      const stripe = fakeStripe();
      stripe.capture.mockImplementation(async (id) => {
        if (id === "pi_first") throw new Error("network");
        return intent("succeeded", id);
      });
      await run(sweepPayments, mongo, stripe);
      expect(await payment("first")).toBe("held");
      expect(await payment("second")).toBe("charged");
    });
  });

  describe("events", () => {
    const live = async (
      stripe: ReturnType<typeof fakeStripe>,
      events: CallEvent[],
      until: () => Promise<boolean>,
    ) =>
      Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const feed = yield* PubSub.sliding<{
              id: string;
              event: CallEvent;
            }>(16);
            yield* Layer.buildWithScope(
              SettleLive.pipe(
                Layer.provide(Layer.succeed(CallFeed, feed as CallFeed)),
                Layer.provide(
                  Layer.succeed(MongoClient, mongo as unknown as MongoClient),
                ),
                Layer.provide(Layer.succeed(StripeClient, stripe.client)),
                Layer.provide(Layer.succeed(PaymentConfig, config)),
              ),
              yield* Effect.scope,
            );
            for (const [i, event] of events.entries())
              yield* PubSub.publish(feed, { id: `${i}-0`, event });
            yield* Effect.promise(() =>
              vi.waitFor(async () => {
                if (!(await until())) throw new Error("not settled yet");
              }),
            );
          }),
        ),
      );

    it("charges on call.started and releases on call.unanswered right away", async () => {
      await seed("answered", { status: "dialing" }, false);
      await seed("busy", { status: "dialing" }, false);
      const stripe = fakeStripe();
      await live(
        stripe,
        [
          {
            event: "call.turn",
            room: "call_answered",
            seq: 1,
            role: "agent",
            text: "Hello",
            at: Date.now(),
          },
          {
            event: "call.started",
            room: "call_answered",
            started_at: Date.now(),
          },
          { event: "call.unanswered", room: "call_busy", ended_at: Date.now() },
        ],
        async () =>
          (await payment("answered")) === "charged" &&
          (await payment("busy")) === "released",
      );
      expect(stripe.capture).toHaveBeenCalledTimes(1);
      expect(stripe.capture).toHaveBeenCalledWith("pi_answered");
      expect(stripe.release).toHaveBeenCalledTimes(1);
      expect(stripe.release).toHaveBeenCalledWith("pi_busy");
    });
    it("keeps handling events after a failed settlement", async () => {
      await seed("first", { status: "dialing" }, false);
      await seed("second", { status: "dialing" }, false);
      const stripe = fakeStripe();
      stripe.capture.mockRejectedValueOnce(new Error("network"));
      await live(
        stripe,
        [
          { event: "call.started", room: "call_first", started_at: 1 },
          { event: "call.started", room: "call_second", started_at: 2 },
        ],
        async () => (await payment("second")) === "charged",
      );
      expect(await payment("first")).toBe("held");
    });
  });
});
