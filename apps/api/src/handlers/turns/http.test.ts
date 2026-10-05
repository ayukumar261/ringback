import { HttpApp, HttpRouter, HttpServerResponse } from "@effect/platform";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { MongoClient, type TurnDoc } from "../../clients/mongo.js";
import { turnsFor, turnsSnapshot } from "./http.js";

// fakeMongo yields the given turn docs or failure and records each find call.
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

describe("turns route", () => {
  it("uses the room from the URL and returns the encoded transcript", async () => {
    const { mongo, finds } = fakeMongo(turnDocs);
    const handler = HttpApp.toWebHandler(
      HttpRouter.empty.pipe(
        HttpRouter.get("/calls/:room/turns", turnsSnapshot),
        Effect.provideService(MongoClient, mongo),
      ),
    );
    const response = await handler(
      new Request("http://localhost/calls/r-a/turns"),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([
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
    expect(finds).toEqual([
      {
        filter: { room: "r-a" },
        options: { projection: { _id: 0 }, sort: { seq: 1 } },
      },
    ]);
  });

  it("returns an empty transcript for an unknown room", async () => {
    const response = await Effect.runPromise(
      turnsFor("unknown").pipe(
        Effect.provideService(MongoClient, fakeMongo([]).mongo),
      ),
    );
    expect(response.status).toBe(200);
    expect(await HttpServerResponse.toWeb(response).json()).toEqual([]);
  });
});
