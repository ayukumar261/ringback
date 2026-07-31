import { HttpServerResponse } from "@effect/platform";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { MongoClient, type TurnDoc } from "../clients/mongo.js";
import { listTurns, turnsFor } from "./turns.js";

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
    role: "caller",
    text: "What are your hours?",
    at: new Date(4000),
  },
];

describe("listTurns", () => {
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
        role: "caller",
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
