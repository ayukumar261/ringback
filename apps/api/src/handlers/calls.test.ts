import { HttpServerResponse } from "@effect/platform";
import { Chunk, Effect, Fiber, PubSub, Stream } from "effect";
import type { Redis } from "ioredis";
import { describe, expect, it } from "vitest";
import { type CallDoc, MongoClient } from "../clients/mongo.js";
import type { CallEvent } from "../events/index.js";
import { CallFeed } from "../pipeline/feed.js";
import { callsSnapshot, events, frame, isAfter, listCalls } from "./calls.js";

// started/ended build decoded events as the materializer would publish them.
const started = (room: string, at: number): CallEvent => ({
  event: "call.started",
  room,
  started_at: at,
});
const ended = (room: string, at: number): CallEvent => ({
  event: "call.ended",
  room,
  ended_at: at,
  duration_ms: 1000,
});

// startedFields/endedFields are the same events as raw stream entry fields.
const startedFields = (room: string, at: number): string[] => {
  return ["event", "call.started", "room", room, "started_at", String(at)];
};
const endedFields = (room: string, at: number): string[] => {
  const fields = ["event", "call.ended", "room", room, "ended_at", String(at)];
  return [...fields, "duration_ms", "1000"];
};

type RawEntry = [id: string, fields: string[]];

// gatedLog holds the xrange reply until released, and signals the call itself.
const gatedLog = () => {
  const starts: string[] = [];
  let release: (entries: RawEntry[]) => void = () => {};
  let called: () => void = () => {};
  const reply = new Promise<RawEntry[]>((r) => (release = r));
  const xrangeCalled = new Promise<void>((r) => (called = r));
  const log = {
    xrange: (_key: string, start: string) => {
      starts.push(start);
      called();
      return reply;
    },
  } as unknown as Redis;
  return { log, starts, release, xrangeCalled };
};

describe("events", () => {
  it("replays entries after Last-Event-ID, then follows live without duplicates", async () => {
    const { log, starts, release, xrangeCalled } = gatedLog();
    const out = await Effect.runPromise(
      Effect.gen(function* () {
        const feed = yield* CallFeed;
        const fiber = yield* events(log, feed, "1-1").pipe(
          Stream.take(3),
          Stream.runCollect,
          Effect.fork,
        );
        // events subscribes before reading history, so once xrange has been
        // called these publishes are already buffered on the live side
        yield* Effect.promise(() => xrangeCalled);
        yield* PubSub.publish(feed, { id: "2-1", event: started("a", 1) });
        yield* PubSub.publish(feed, { id: "3-1", event: ended("a", 2) });
        yield* PubSub.publish(feed, { id: "4-1", event: started("b", 3) });
        release([
          ["2-1", startedFields("a", 1)],
          ["3-1", endedFields("a", 2)],
        ]);
        return Chunk.toReadonlyArray(yield* Fiber.join(fiber));
      }).pipe(Effect.provide(CallFeed.Default)),
    );
    expect(out.map((e) => e.id)).toEqual(["2-1", "3-1", "4-1"]);
    expect(out[0]?.event).toEqual(started("a", 1));
    expect(out[1]?.event).toEqual(ended("a", 2));
    expect(starts).toEqual(["(1-1"]);
  });

  it("falls back to the raw cursor when there is no newer history", async () => {
    const { log, release, xrangeCalled } = gatedLog();
    const out = await Effect.runPromise(
      Effect.gen(function* () {
        const feed = yield* CallFeed;
        const fiber = yield* events(log, feed, "5-0").pipe(
          Stream.take(1),
          Stream.runCollect,
          Effect.fork,
        );
        yield* Effect.promise(() => xrangeCalled);
        // the cursor entry itself arriving live must not be re-delivered
        yield* PubSub.publish(feed, { id: "5-0", event: started("a", 1) });
        yield* PubSub.publish(feed, { id: "5-1", event: started("b", 2) });
        release([]);
        return Chunk.toReadonlyArray(yield* Fiber.join(fiber));
      }).pipe(Effect.provide(CallFeed.Default)),
    );
    expect(out.map((e) => e.id)).toEqual(["5-1"]);
  });

  it("skips undecodable history entries", async () => {
    const { log, release } = gatedLog();
    release([
      ["1-1", ["event", "mystery"]],
      ["2-1", startedFields("a", 1)],
    ]);
    const out = await Effect.runPromise(
      Effect.gen(function* () {
        const feed = yield* CallFeed;
        return Chunk.toReadonlyArray(
          yield* events(log, feed, "1-0").pipe(
            Stream.take(1),
            Stream.runCollect,
          ),
        );
      }).pipe(Effect.provide(CallFeed.Default)),
    );
    expect(out.map((e) => e.id)).toEqual(["2-1"]);
  });

  it("treats a malformed Last-Event-ID as a fresh subscription", async () => {
    const poisoned = {
      xrange: () => Promise.reject(new Error("must not read history")),
    } as unknown as Redis;
    const out = await Effect.runPromise(
      Effect.gen(function* () {
        const feed = yield* CallFeed;
        const fiber = yield* events(poisoned, feed, "yesterday").pipe(
          Stream.take(1),
          Stream.runCollect,
          Effect.fork,
        );
        // no history read on this path; a beat for the subscription to start
        yield* Effect.sleep("20 millis");
        yield* PubSub.publish(feed, { id: "1-1", event: started("a", 1) });
        return Chunk.toReadonlyArray(yield* Fiber.join(fiber));
      }).pipe(Effect.provide(CallFeed.Default)),
    );
    expect(out.map((e) => e.id)).toEqual(["1-1"]);
  });
});

describe("isAfter", () => {
  it("orders entry ids by ms part, then sequence part", () => {
    expect(isAfter("2-0", "1-99")).toBe(true);
    expect(isAfter("1-2", "1-1")).toBe(true);
    expect(isAfter("1-1", "1-2")).toBe(false);
    expect(isAfter("1-1", "1-1")).toBe(false);
  });

  it("compares numerically, not lexicographically", () => {
    expect(isAfter("10-0", "9-5")).toBe(true);
    expect(isAfter("1-10", "1-9")).toBe(true);
  });
});

describe("frame", () => {
  it("renders an SSE message addressed by its entry id", () => {
    expect(frame({ id: "1-1", event: started("a", 5) })).toBe(
      'id: 1-1\nevent: call.started\ndata: {"event":"call.started","room":"a","started_at":5}\n\n',
    );
  });
});

// fakeMongo yields the given docs (or failure) and records each find call.
const fakeMongo = (result: CallDoc[] | Error) => {
  const finds: unknown[] = [];
  const mongo = {
    calls: {
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

const activeDoc: CallDoc = {
  room: "r-a",
  status: "active",
  conversationId: "conv-1",
  from: "+15550001111",
  to: "+15550002222",
  startedAt: new Date(1000),
};

const endedDoc: CallDoc = {
  room: "r-b",
  status: "ended",
  conversationId: "conv-2",
  from: "+15550003333",
  to: "+15550004444",
  startedAt: new Date(2000),
  endedAt: new Date(62000),
  durationMs: 60000,
};

describe("listCalls", () => {
  it("encodes docs into the SSE wire dialect", async () => {
    const { mongo } = fakeMongo([endedDoc, activeDoc]);
    const out = await Effect.runPromise(listCalls(mongo));
    expect(out).toEqual([
      {
        room: "r-b",
        status: "ended",
        conversation_id: "conv-2",
        from: "+15550003333",
        to: "+15550004444",
        started_at: 2000,
        ended_at: 62000,
        duration_ms: 60000,
      },
      {
        room: "r-a",
        status: "active",
        conversation_id: "conv-1",
        from: "+15550001111",
        to: "+15550002222",
        started_at: 1000,
      },
    ]);
  });

  it("omits absent optional fields", async () => {
    const { mongo } = fakeMongo([
      {
        room: "r-x",
        status: "ended",
        endedAt: new Date(5000),
        durationMs: 100,
      },
    ]);
    const out = await Effect.runPromise(listCalls(mongo));
    expect(Object.keys(out[0] ?? {}).sort()).toEqual([
      "duration_ms",
      "ended_at",
      "room",
      "status",
    ]);
  });

  it("asks Mongo for the newest calls, capped, without _id", async () => {
    const { mongo, finds } = fakeMongo([]);
    await Effect.runPromise(listCalls(mongo));
    expect(finds).toEqual([
      {
        filter: {},
        options: {
          projection: { _id: 0 },
          sort: { startedAt: -1 },
          limit: 100,
        },
      },
    ]);
  });

  it("returns an empty array for an empty collection", async () => {
    const { mongo } = fakeMongo([]);
    expect(await Effect.runPromise(listCalls(mongo))).toEqual([]);
  });
});

describe("callsSnapshot", () => {
  const run = (result: CallDoc[] | Error) =>
    Effect.runPromise(
      callsSnapshot.pipe(
        Effect.provideService(MongoClient, fakeMongo(result).mongo),
      ),
    );

  it("responds 200 on success", async () => {
    const response = await run([activeDoc]);
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
    const response = await run([{ room: "r-x", status: "weird" as never }]);
    expect(response.status).toBe(500);
  });
});
