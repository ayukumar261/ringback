import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import { MongoClient as Driver } from "mongodb";
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
  ElevenLabsClient,
  ElevenLabsError,
  type Conversation,
} from "../clients/elevenlabs.js";
import {
  createExpenseIndexes,
  MongoClient,
  type ExpenseDoc,
} from "../clients/mongo.js";
import {
  TwilioCallError,
  TwilioClient,
  type TwilioCall,
} from "../clients/twilio.js";
import { collectExpense } from "./collector.js";

const mongoUri = process.env.MONGODB_URI;
const sid = `CA${"1".repeat(32)}`;

describe.skipIf(!mongoUri)("expense collector", () => {
  const driver = new Driver(mongoUri ?? "mongodb://127.0.0.1:27017", {
    serverSelectionTimeoutMS: 3000,
  });
  const db = driver.db(`ringback_test_${randomUUID().replaceAll("-", "")}`);
  const expenses = db.collection<ExpenseDoc>("expenses");
  const getCall =
    vi.fn<(sid: string) => Effect.Effect<TwilioCall, TwilioCallError>>();
  const getConversation =
    vi.fn<(id: string) => Effect.Effect<Conversation, ElevenLabsError>>();
  const collect = () =>
    Effect.runPromise(
      collectExpense.pipe(
        Effect.provideService(MongoClient, { expenses } as MongoClient),
        Effect.provideService(
          TwilioClient,
          TwilioClient.make({ lookup: () => Effect.die("unused"), getCall }),
        ),
        Effect.provideService(
          ElevenLabsClient,
          ElevenLabsClient.make({ getConversation }),
        ),
      ),
    );
  const queue = (provider: ExpenseDoc["provider"]) => {
    const twilio = provider === "twilio";
    const type = twilio ? "elastic_sip_trunking" : "elevenlabs_agent";
    const reference = twilio ? sid : "conv-test";
    const now = new Date();
    return expenses.insertOne({
      _id: `${type}:${reference}`,
      environment: "development",
      room: "call-test",
      provider,
      type,
      providerReference: reference,
      amountCents: null,
      currency: null,
      status: "pending",
      incurredAt: now,
      createdAt: now,
      updatedAt: now,
      collection: { attempts: 0, nextAttemptAt: now },
    });
  };
  beforeAll(async () => {
    await driver.connect();
    await createExpenseIndexes(expenses);
  });
  beforeEach(async () => {
    await expenses.deleteMany({});
    getCall.mockReset();
    getConversation.mockReset();
  });
  afterAll(async () => {
    try {
      await db.dropDatabase();
    } finally {
      await driver.close();
    }
  });

  it("reports Twilio's negative dollar price as positive cents", async () => {
    await queue("twilio");
    getCall.mockReturnValue(
      Effect.succeed({
        status: "completed",
        price: "-0.0085",
        price_unit: "USD",
      }),
    );
    expect(await collect()).toBe(true);
    const expense = (await expenses.findOne())!;
    expect(expense).toMatchObject({ status: "reported", currency: "usd" });
    expect(expense.amountCents!.toString()).toBe("0.85");
    expect(expense).not.toHaveProperty("collection");
    expect(getCall).toHaveBeenCalledWith(sid);
    expect(await collect()).toBe(false);
  });

  it("reports ElevenLabs' dollar total as cents, keeping fractions", async () => {
    await queue("elevenlabs");
    getConversation.mockReturnValue(
      Effect.succeed({ status: "done", metadata: { cost_fiat: 0.0951234 } }),
    );
    expect(await collect()).toBe(true);
    const expense = (await expenses.findOne())!;
    expect(expense).toMatchObject({ status: "reported", currency: "usd" });
    expect(expense.amountCents!.toString()).toBe("9.51234");
    expect(getConversation).toHaveBeenCalledWith("conv-test");
  });

  it.each([
    ["Twilio is still pricing the call", "twilio", "pricing_pending"],
    ["Twilio fails", "twilio", "http_503"],
    ["ElevenLabs is still pricing it", "elevenlabs", "pricing_pending"],
    ["ElevenLabs fails", "elevenlabs", "unavailable"],
  ] as const)("retries later when %s", async (_, provider, lastError) => {
    await queue(provider);
    getCall.mockReturnValue(
      lastError === "pricing_pending"
        ? Effect.succeed({
            status: "in-progress",
            price: null,
            price_unit: null,
          })
        : Effect.fail(new TwilioCallError({ code: "http_503" })),
    );
    getConversation.mockReturnValue(
      lastError === "pricing_pending"
        ? Effect.succeed({
            status: "processing",
            metadata: { cost_fiat: null },
          })
        : Effect.fail(new ElevenLabsError({ code: "unavailable" })),
    );
    const before = Date.now();
    expect(await collect()).toBe(true);
    const expense = (await expenses.findOne())!;
    expect(expense).toMatchObject({
      status: "pending",
      amountCents: null,
      collection: { attempts: 1, lastError },
    });
    const wait = expense.collection!.nextAttemptAt.getTime() - before;
    expect(wait).toBeGreaterThanOrEqual(30_000);
    expect(wait).toBeLessThan(31_000);
    expect(await collect()).toBe(false);
  });

  it("lets only one collector work on an expense at a time", async () => {
    await queue("twilio");
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    getCall.mockReturnValue(
      Effect.promise(() => gate).pipe(
        Effect.as({ status: "completed", price: "-1", price_unit: "USD" }),
      ),
    );
    const first = collect();
    await vi.waitFor(() => expect(getCall).toHaveBeenCalled());
    expect(await collect()).toBe(false);
    release();
    expect(await first).toBe(true);
    expect(getCall).toHaveBeenCalledTimes(1);
    expect((await expenses.findOne())!.amountCents!.toString()).toBe("100");
  });
});
