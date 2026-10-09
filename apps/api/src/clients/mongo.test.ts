import { randomUUID } from "node:crypto";
import { MongoClient as Driver } from "mongodb";
import { describe, expect, it, beforeAll, beforeEach, afterAll } from "vitest";
import {
  createRequestIndexes,
  createPurchaseIndexes,
  type RequestDoc,
  type PurchaseDoc,
} from "./mongo.js";

const mongoUri = process.env.MONGODB_URI;
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
const requestFixture = (changes: Partial<RequestDoc> = {}): RequestDoc => {
  const record: RequestDoc = {
    _id: "request-test",
    ...input,
    inputHash: "test-input",
    requestSnapshotHash: "test-snapshot",
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
  };
  return record;
};
const purchaseFixture = (changes: Partial<PurchaseDoc> = {}): PurchaseDoc => ({
  _id: "acct_test:test:cs_test",
  requestId: "request-test",
  stripeAccountId: "acct_test",
  livemode: false,
  checkoutSessionId: "cs_test",
  paymentIntentId: "pi_test",
  customer: { stripeId: "cus_test", name: null, email: null, phone: null },
  amountTotal: 50,
  currency: "usd",
  recordedAt: new Date(),
  ...changes,
});

describe.skipIf(!mongoUri)("payment collection indexes", () => {
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
  });
  afterAll(async () => {
    try {
      await db.dropDatabase();
    } finally {
      await driver.close();
    }
  });
  it("allows unbound requests but enforces uniqueness of a bound session within an account/mode", async () => {
    await mongo.requests.insertMany([
      requestFixture({ _id: "one", checkout: undefined }),
      requestFixture({ _id: "two", checkout: undefined }),
    ]);
    await mongo.requests.insertOne(requestFixture());
    await expect(
      mongo.requests.insertOne(requestFixture({ _id: "duplicate" })),
    ).rejects.toMatchObject({ code: 11000 });
    await mongo.requests.insertOne(
      requestFixture({
        _id: "another-account",
        checkout: {
          id: "cs_test",
          url: "url",
          accountId: "other",
          livemode: false,
        },
      }),
    );
  });
  it("enforces purchase session uniqueness independently of document IDs", async () => {
    await mongo.purchases.insertOne(purchaseFixture());
    await expect(
      mongo.purchases.insertOne(purchaseFixture({ _id: "another-id" })),
    ).rejects.toMatchObject({ code: 11000 });
  });
  it("binds a retry key hash to one random request per environment", async () => {
    await mongo.requests.insertOne(
      requestFixture({
        _id: "random-one",
        retry: { keyHash: "same-key" },
        checkout: undefined,
      }),
    );
    await expect(
      mongo.requests.insertOne(
        requestFixture({
          _id: "random-two",
          retry: { keyHash: "same-key" },
          checkout: undefined,
        }),
      ),
    ).rejects.toMatchObject({ code: 11000 });
    await mongo.requests.insertOne(
      requestFixture({
        _id: "production",
        environment: "production",
        retry: { keyHash: "same-key" },
        checkout: undefined,
      }),
    );
    expect(await mongo.requests.countDocuments()).toBe(2);
  });
  it("creates indexes idempotently and includes the queue/customer lookup indexes", async () => {
    await createRequestIndexes(mongo.requests);
    await createPurchaseIndexes(mongo.purchases);
    expect(
      (await mongo.requests.listIndexes().toArray()).map((i) => i.key),
    ).toContainEqual({ status: 1, createdAt: 1 });
    expect(
      (await mongo.purchases.listIndexes().toArray()).map((i) => i.key),
    ).toContainEqual({
      stripeAccountId: 1,
      livemode: 1,
      "customer.stripeId": 1,
      recordedAt: -1,
    });
  });
});
