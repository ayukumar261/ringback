import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import { MongoClient as Driver } from "mongodb";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createExpenseIndexes,
  type ExpenseDoc,
  type MongoClient,
  type RequestDoc,
} from "../clients/mongo.js";
import type { WorkerEvent } from "../events/index.js";
import { decimal } from "./money.js";
import { captureExpense, recordLookup } from "./store.js";

const mongoUri = process.env.MONGODB_URI;
const at = Date.parse("2026-11-01T12:00:00Z");
const sid = `CA${"1".repeat(32)}`;

it("logs a failed Lookup write instead of failing the call request", async () => {
  const mongo = {
    expenses: {
      insertOne: async () => {
        throw new Error("storage unavailable");
      },
    },
  } as unknown as MongoClient;
  await expect(
    Effect.runPromise(recordLookup(mongo, "development", {})),
  ).resolves.toBeUndefined();
});

describe.skipIf(!mongoUri)("expense store", () => {
  const driver = new Driver(mongoUri ?? "mongodb://127.0.0.1:27017", {
    serverSelectionTimeoutMS: 3000,
  });
  const db = driver.db(`ringback_test_${randomUUID().replaceAll("-", "")}`);
  const collections = {
    expenses: db.collection<ExpenseDoc>("expenses"),
    requests: db.collection<RequestDoc>("requests"),
  };
  const mongo = collections as unknown as MongoClient;
  const capture = (event: WorkerEvent) =>
    Effect.runPromise(captureExpense(mongo, "development", event));
  beforeAll(async () => {
    await driver.connect();
    await createExpenseIndexes(collections.expenses);
  });
  beforeEach(async () => {
    await Promise.all(
      Object.values(collections).map((collection) => collection.deleteMany({})),
    );
  });
  afterAll(async () => {
    try {
      await db.dropDatabase();
    } finally {
      await driver.close();
    }
  });

  it("records each billed Lookup at an estimated 0.8 cents", async () => {
    await Effect.runPromise(
      recordLookup(mongo, "development", {
        requestId: "request-test",
        room: "call_request-test",
      }),
    );
    await Effect.runPromise(recordLookup(mongo, "development", {}));
    const linked = await collections.expenses.findOne({
      requestId: "request-test",
    });
    const unlinked = await collections.expenses.findOne({
      requestId: { $exists: false },
    });
    for (const expense of [linked, unlinked]) {
      expect(expense).toMatchObject({
        provider: "twilio",
        type: "lookup_api",
        currency: "usd",
        status: "estimated",
      });
      expect(expense!.amountCents!.toString()).toBe("0.8");
      expect(expense).not.toHaveProperty("collection");
    }
    expect(linked!.room).toBe("call_request-test");
    expect(unlinked).not.toHaveProperty("room");
  });

  it("queues a call's SIP and ElevenLabs charges, linked to its request", async () => {
    await collections.requests.insertOne({
      _id: "request-test",
      room: "call_request-test",
      environment: "production",
    } as RequestDoc);
    await capture({
      event: "call.sip",
      room: "call_request-test",
      call_sid: sid,
      at,
    });
    await capture({
      event: "call.started",
      room: "call_request-test",
      conversation_id: "conv-test",
      started_at: at,
    });
    const pending = {
      environment: "production",
      requestId: "request-test",
      room: "call_request-test",
      amountCents: null,
      currency: null,
      status: "pending",
      incurredAt: new Date(at),
      collection: { attempts: 0 },
    };
    expect(
      await collections.expenses.find().sort({ _id: 1 }).toArray(),
    ).toMatchObject([
      {
        ...pending,
        _id: `elastic_sip_trunking:${sid}`,
        provider: "twilio",
        type: "elastic_sip_trunking",
        providerReference: sid,
      },
      {
        ...pending,
        _id: "elevenlabs_agent:conv-test",
        provider: "elevenlabs",
        type: "elevenlabs_agent",
        providerReference: "conv-test",
      },
    ]);
  });

  it("leaves a priced charge untouched when its event is replayed", async () => {
    const event = { event: "call.sip", room: "call-test", call_sid: sid, at };
    await capture(event as WorkerEvent);
    await collections.expenses.updateOne(
      {},
      {
        $set: {
          amountCents: decimal("0.85"),
          currency: "usd",
          status: "reported",
        },
        $unset: { collection: "" },
      },
    );
    await capture(event as WorkerEvent);
    const expenses = await collections.expenses.find().toArray();
    expect(expenses).toHaveLength(1);
    expect(expenses[0]).toMatchObject({
      environment: "development",
      status: "reported",
    });
    expect(expenses[0]!.amountCents!.toString()).toBe("0.85");
    expect(expenses[0]).not.toHaveProperty("collection");
  });

  it("skips a call.started without a conversation ID", async () => {
    await capture({ event: "call.started", room: "call-test", started_at: at });
    expect(await collections.expenses.countDocuments()).toBe(0);
  });

  it("makes only the ended room's queued charges due at hangup", async () => {
    await capture({ event: "call.sip", room: "call-a", call_sid: sid, at });
    await capture({
      event: "call.sip",
      room: "call-b",
      call_sid: `CA${"2".repeat(32)}`,
      at,
    });
    await capture({
      event: "call.ended",
      room: "call-a",
      ended_at: at,
      duration_ms: 1000,
    });
    const due = async (room: string) =>
      (await collections.expenses.findOne({ room }))!.collection!
        .nextAttemptAt <= new Date();
    expect(await due("call-a")).toBe(true);
    expect(await due("call-b")).toBe(false);
  });
});
