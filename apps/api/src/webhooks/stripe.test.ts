import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import { MongoClient as Driver } from "mongodb";
import {
  MongoClient,
  createRequestIndexes,
  createPurchaseIndexes,
  type RequestDoc,
  type PurchaseDoc,
} from "../clients/mongo.js";
import {
  StripeClient,
  StripeError,
  verifyStripeEvent,
} from "../clients/stripe.js";
import { hash, requestSnapshotHash } from "../handlers/payments/schema.js";
import { HttpApp, HttpRouter } from "@effect/platform";
import Stripe from "stripe";
import {
  describe,
  expect,
  it,
  vi,
  beforeAll,
  beforeEach,
  afterAll,
} from "vitest";
import { handleStripeEvent, stripeWebhook } from "./stripe.js";
import { readCallRequest } from "../handlers/payments/http.js";
import { newAccessToken, newCallAccess } from "../handlers/payments/access.js";

const accessToken = newAccessToken();

const route = HttpRouter.empty.pipe(
  HttpRouter.post("/webhooks/stripe", stripeWebhook),
);
const input = {
  to: "+15551234567",
  prompt: "Ask for an economy flight price from SFO to LAX.",
};
const settings = {
  amount: 50,
  currency: "usd",
  maxDuration: 120,
  publicApiUrl: "http://localhost:3001",
  publicWebUrl: "http://localhost:3000",
  environment: "development" as const,
  requireTerms: false,
};
const mongoUri = process.env.MONGODB_URI;
const secret = "whsec_test_fixture";
const requestFixture = (changes: Partial<RequestDoc> = {}): RequestDoc => {
  const record = {
    _id: "request-test",
    ...input,
    inputHash: hash(input),
    access: newCallAccess(accessToken, new Date()),
    ...settings,
    policyVersion: "prompt-rules-v1",
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 35 * 60_000),
    status: "unpaid",
    room: "call_request-test",
    checkout: {
      id: "cs_test",
      url: "https://checkout.stripe.com/test",
      accountId: "acct_test",
      livemode: false,
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
    livemode: false,
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
    findOne: vi.fn<(...args: unknown[]) => Promise<RequestDoc | null>>(
      async () => null,
    ),
    insertOne: vi.fn(async () => ({})),
  },
});
const harness = (
  mongo:
    | Pick<MongoClient, "requests">
    | ReturnType<typeof fakeMongo> = fakeMongo(),
) => {
  let session = sessionFixture();
  const retrieveSession = vi.fn<
    (
      id: string,
    ) => Promise<{ accountId: string; session: Stripe.Checkout.Session }>
  >(async () => ({ accountId: "acct_test", session }));
  const verify = vi.fn((payload: Buffer, signature?: string) =>
    verifyStripeEvent(payload, signature, secret),
  );
  const stripe = StripeClient.make({
    retrieveSession: (id) =>
      Effect.tryPromise({
        try: () => retrieveSession(id),
        catch: () => new StripeError({ code: "unavailable" }),
      }),
    createSession: () =>
      Effect.dieMessage("Webhooks must not create Checkout sessions"),
    verifyEvent: verify,
  });
  const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(MongoClient, mongo as MongoClient),
      Effect.provideService(StripeClient, stripe),
    );
  const run = <A, E>(effect: Effect.Effect<A, E, MongoClient | StripeClient>) =>
    Effect.runPromise(provide(effect));
  // Seed the checkout state that this webhook receives, without invoking the checkout handler.
  const checkout = async (changes: Partial<RequestDoc> = {}) => {
    const record = requestFixture(changes);
    await mongo.requests.insertOne(record);
    session = sessionFixture({
      status: "open",
      payment_status: "unpaid",
      metadata: { request_snapshot_hash: record.requestSnapshotHash },
    });
    return { result: { call_id: record._id }, session };
  };
  const paid = async () => {
    const result = await checkout();
    Object.assign(result.session, {
      status: "complete",
      payment_status: "paid",
    });
    await run(handleStripeEvent(event(result.session)));
    return result;
  };
  return {
    retrieveSession,
    verify,
    run,
    checkout,
    paid,
    http: (app: typeof route) => HttpApp.toWebHandler(provide(app)),
  };
};

describe("Stripe webhook HTTP", () => {
  it("verifies the exact bytes before processing a signed event", async () => {
    const mongo = fakeMongo();
    const h = harness(mongo);
    const payload = JSON.stringify(event(sessionFixture()), null, 2);
    const signature = Stripe.webhooks.generateTestHeaderString({
      payload,
      secret,
    });
    const response = await h.http(route)(
      new Request("http://localhost/webhooks/stripe", {
        method: "POST",
        body: payload,
        headers: { "Stripe-Signature": signature },
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ received: true });
    expect(h.verify).toHaveBeenCalledWith(Buffer.from(payload), signature);
    expect(mongo.requests.findOne).toHaveBeenCalledWith({
      _id: "request-test",
    });
  });
  it("rejects altered or unsigned bodies without touching Mongo", async () => {
    const mongo = fakeMongo();
    const h = harness(mongo);
    const payload = JSON.stringify(event(sessionFixture()));
    const signature = Stripe.webhooks.generateTestHeaderString({
      payload,
      secret,
    });
    for (const headers of [
      new Headers(),
      new Headers({ "Stripe-Signature": signature }),
    ]) {
      const response = await h.http(route)(
        new Request("http://localhost/webhooks/stripe", {
          method: "POST",
          body: payload + " ",
          headers,
        }),
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "invalid_request" });
    }
    expect(mongo.requests.findOne).not.toHaveBeenCalled();
  });
  it("returns a retryable error when Checkout binding is pending", async () => {
    const mongo = fakeMongo();
    mongo.requests.findOne.mockResolvedValue(
      requestFixture({ checkout: undefined }),
    );
    const payload = JSON.stringify(event(sessionFixture()));
    const response = await harness(mongo).http(route)(
      new Request("http://localhost/webhooks/stripe", {
        method: "POST",
        body: payload,
        headers: {
          "Stripe-Signature": Stripe.webhooks.generateTestHeaderString({
            payload,
            secret,
          }),
        },
      }),
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "unavailable" });
  });
  it("acknowledges unrelated events without querying Mongo", async () => {
    const mongo = fakeMongo();
    const h = harness(mongo);
    expect(
      await h.run(
        handleStripeEvent(event(sessionFixture(), "customer.created")),
      ),
    ).toEqual({ received: true });
    expect(mongo.requests.findOne).not.toHaveBeenCalled();
  });
  it("rejects a malformed Checkout event", async () => {
    const e = event(sessionFixture());
    Object.assign(e.data.object, { object: "customer" });
    await expect(harness().run(handleStripeEvent(e))).rejects.toThrow(
      "invalid_request",
    );
  });
});

describe.skipIf(!mongoUri)("webhook persistence", () => {
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
  const h = { ...harness(mongo), mongo };
  it("trusts the session Stripe returns over the event body", async () => {
    const { result, session } = await h.checkout();
    await h.run(
      handleStripeEvent(
        event({ ...session, status: "complete", payment_status: "paid" }),
      ),
    );
    expect(
      (await h.run(readCallRequest(result.call_id, accessToken))).status,
    ).toBe("unpaid");
    expect(await h.mongo.purchases.countDocuments()).toBe(0);
    Object.assign(session, { status: "complete", payment_status: "paid" });
    await h.run(handleStripeEvent(event(session)));
    expect(
      (await h.run(readCallRequest(result.call_id, accessToken))).status,
    ).toBe("paid");
    expect(await h.mongo.purchases.countDocuments()).toBe(1);
  });
  it("deduplicates simultaneous webhooks and ignores a stale expiry notification", async () => {
    const { result, session } = await h.paid();
    await Promise.all(
      Array.from({ length: 10 }, () =>
        h.run(handleStripeEvent(event(session))),
      ),
    );
    expect(await h.mongo.purchases.countDocuments()).toBe(1);
    await h.run(handleStripeEvent(event(session, "checkout.session.expired")));
    expect(
      (await h.run(readCallRequest(result.call_id, accessToken))).status,
    ).toBe("paid");
  });
  it.each([
    "amount_total",
    "currency",
    "client_reference_id",
    "livemode",
    "metadata",
    "id",
    "mode",
  ] as const)("rejects mismatched %s", async (field) => {
    const { result, session } = await h.checkout();
    const original = event(session);
    Object.assign(session, {
      status: "complete",
      payment_status: "paid",
      [field]:
        field === "amount_total"
          ? 1
          : field === "livemode"
            ? true
            : field === "metadata"
              ? {}
              : "wrong",
    });
    await expect(h.run(handleStripeEvent(original))).rejects.toThrow(
      "conflict",
    );
    expect(
      (await h.run(readCallRequest(result.call_id, accessToken))).status,
    ).toBe("unpaid");
    expect(await h.mongo.purchases.countDocuments()).toBe(0);
  });
  it("rejects another Stripe account and a mutated request", async () => {
    const { result, session } = await h.checkout();
    Object.assign(session, { status: "complete", payment_status: "paid" });
    h.retrieveSession.mockResolvedValueOnce({
      accountId: "acct_other",
      session,
    });
    await expect(h.run(handleStripeEvent(event(session)))).rejects.toThrow(
      "conflict",
    );
    await h.mongo.requests.updateOne(
      { _id: result.call_id },
      { $set: { to: "+15550000000" } },
    );
    await expect(h.run(handleStripeEvent(event(session)))).rejects.toThrow(
      "conflict",
    );
  });
  it("enforces the stored terms setting after configuration changes", async () => {
    const { session } = await h.checkout({ requireTerms: true });
    Object.assign(session, { status: "complete", payment_status: "paid" });
    await expect(h.run(handleStripeEvent(event(session)))).rejects.toThrow(
      "invalid_request",
    );
    session.consent = { terms_of_service: "accepted", promotions: null };
    await h.run(handleStripeEvent(event(session)));
    expect(await h.mongo.purchases.countDocuments()).toBe(1);
  });
  it("marks an expired checkout and can recover on authoritative payment", async () => {
    const { result, session } = await h.checkout();
    session.status = "expired";
    await h.run(handleStripeEvent(event(session, "checkout.session.expired")));
    expect(
      (await h.run(readCallRequest(result.call_id, accessToken))).status,
    ).toBe("expired");
    Object.assign(session, { status: "complete", payment_status: "paid" });
    await h.run(handleStripeEvent(event(session)));
    expect(
      (await h.run(readCallRequest(result.call_id, accessToken))).status,
    ).toBe("paid");
  });
  it("recovers after purchase persistence succeeds but queue persistence fails", async () => {
    const { result, session } = await h.checkout();
    Object.assign(session, { status: "complete", payment_status: "paid" });
    const update = vi
      .spyOn(h.mongo.requests, "updateOne")
      .mockRejectedValueOnce(new Error("connection lost"));
    await expect(h.run(handleStripeEvent(event(session)))).rejects.toThrow();
    update.mockRestore();
    expect(await h.mongo.purchases.countDocuments()).toBe(1);
    await h.run(handleStripeEvent(event(session)));
    expect(
      (await h.run(readCallRequest(result.call_id, accessToken))).status,
    ).toBe("paid");
    expect(await h.mongo.purchases.countDocuments()).toBe(1);
  });
});
