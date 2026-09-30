import { HttpServerResponse } from "@effect/platform";
import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { MongoClient, type TurnDoc } from "../clients/mongo.js";
import { listTurns, TurnSnapshot, turnsFor } from "./turns.js";

// fakeMongo yields the given turn docs (or failure) and records each find call.
const fakeMongo = (result: TurnDoc[] | Error) => {
  const finds: unknown[] = [];
  const mongo = {
    turns: {
      find: (filter: unknown, options: unknown) => {
        finds.push({ filter, options });
        return {
          toArray: () =>
            result instanceof Error
              ? Promise.reject(result)
              : Promise.resolve(result),
        };
      },
    },
  } as unknown as MongoClient;
  return { mongo, finds };
};

const turnDocs: TurnDoc[] = [
  {
    room: "r-a",
    seq: 1,
    role: "agent",
    text: "Hello, how can I help?",
    at: new Date(1000),
  },
  {
    room: "r-a",
    seq: 2,
    role: "user",
    text: "What are your hours?",
    at: new Date(4000),
  },
];

describe("listTurns", () => {
  it.each(["agent", "tool"] as const)(
    "round-trips a %s span as unix milliseconds",
    async (role) => {
      const doc: TurnDoc = {
        room: "r-a",
        seq: 1,
        role,
        text: "Hello",
        at: new Date(900),
        startedAt: new Date(1000),
        endedAt: new Date(1400),
        durationMs: 400,
      };
      const { mongo } = fakeMongo([doc]);
      const out = await Effect.runPromise(listTurns(mongo, "r-a"));
      expect(out).toStrictEqual([
        {
          room: "r-a",
          seq: 1,
          role,
          text: "Hello",
          at: 900,
          started_at: 1000,
          ended_at: 1400,
          duration_ms: 400,
        },
      ]);
      expect(Schema.decodeUnknownSync(TurnSnapshot)(out[0])).toStrictEqual(doc);
    },
  );

  it("omits unknown spans and unfinished end fields", async () => {
    const { mongo } = fakeMongo([
      { room: "r-a", seq: 1, role: "user", text: "Hi", at: new Date(0) },
      {
        room: "r-a",
        seq: 2,
        role: "agent",
        text: "Hello",
        at: new Date(1),
        startedAt: new Date(0),
      },
    ]);
    expect(await Effect.runPromise(listTurns(mongo, "r-a"))).toStrictEqual([
      { room: "r-a", seq: 1, role: "user", text: "Hi", at: 0 },
      {
        room: "r-a",
        seq: 2,
        role: "agent",
        text: "Hello",
        at: 1,
        started_at: 0,
      },
    ]);
  });

  it("encodes docs into the SSE wire dialect", async () => {
    const { mongo } = fakeMongo(turnDocs);
    const out = await Effect.runPromise(listTurns(mongo, "r-a"));
    expect(out).toEqual([
      {
        room: "r-a",
        seq: 1,
        role: "agent",
        text: "Hello, how can I help?",
        at: 1000,
      },
      {
        room: "r-a",
        seq: 2,
        role: "user",
        text: "What are your hours?",
        at: 4000,
      },
    ]);
  });

  it("asks Mongo for one room's turns in order, without _id", async () => {
    const { mongo, finds } = fakeMongo([]);
    await Effect.runPromise(listTurns(mongo, "r-a"));
    expect(finds).toEqual([
      {
        filter: { room: "r-a" },
        options: { projection: { _id: 0 }, sort: { seq: 1 } },
      },
    ]);
  });

  it("returns an empty array for an unknown room", async () => {
    const { mongo } = fakeMongo([]);
    expect(await Effect.runPromise(listTurns(mongo, "r-x"))).toEqual([]);
  });
});

describe("turnsFor", () => {
  const run = (result: TurnDoc[] | Error) =>
    Effect.runPromise(
      turnsFor("r-a").pipe(
        Effect.provideService(MongoClient, fakeMongo(result).mongo),
      ),
    );

  it("responds 200 on success", async () => {
    const response = await run(turnDocs);
    expect(response.status).toBe(200);
  });

  it("responds 500 when Mongo fails", async () => {
    const response = await run(new Error("mongo down"));
    expect(response.status).toBe(500);
    expect(await HttpServerResponse.toWeb(response).json()).toEqual({
      error: "internal",
    });
  });

  it("responds 500 on an undecodable doc", async () => {
    const response = await run([
      { room: "r-a", seq: 1, role: "weird" as never, text: "", at: new Date() },
    ]);
    expect(response.status).toBe(500);
  });
});
