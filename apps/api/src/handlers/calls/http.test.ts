import {
  HttpApp,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "@effect/platform";
import {
  Chunk,
  ConfigProvider,
  Effect,
  Fiber,
  Option,
  Stream,
  TestClock,
  TestContext,
} from "effect";
import { describe, expect, it, vi } from "vitest";
import { type CallDoc, MongoClient } from "../../clients/mongo.js";
import { type CallEvent, decodeCallEvent } from "../../events/index.js";
import { callsFeed, callsSnapshot, frame } from "./http.js";
import { CallsConfig } from "./config.js";

const settings = CallsConfig.make({
  snapshotLimit: 100,
  keepaliveMs: 15000,
  retryMs: 3000,
});
import { CallFeed } from "../../pipeline/feed.js";
import { RedisClient } from "../../clients/redis.js";

const started = (room: string, at: number): CallEvent => ({
  event: "call.started",
  room,
  started_at: at,
});

describe("frame", () => {
  it("renders an SSE message addressed by its entry id", () => {
    expect(frame({ id: "1-1", event: started("a", 5) })).toBe(
      'id: 1-1\nevent: call.started\ndata: {"event":"call.started","room":"a","started_at":5}\n\n',
    );
  });

  it.each(["agent", "tool"])(
    "carries a decoded %s span in SSE",
    async (role) => {
      const event = await Effect.runPromise(
        decodeCallEvent({
          event: "call.turn",
          room: "r-a",
          seq: "1",
          role,
          text: "Hello",
          at: "900",
          started_at: "1000",
          ended_at: "1400",
          duration_ms: "400",
        }),
      );
      expect(frame({ id: "1-1", event })).toBe(
        `id: 1-1\nevent: call.turn\ndata: ${JSON.stringify({
          event: "call.turn",
          room: "r-a",
          seq: 1,
          role,
          text: "Hello",
          at: 900,
          started_at: 1000,
          ended_at: 1400,
          duration_ms: 400,
        })}\n\n`,
      );
    },
  );

  it("carries the recording start in SSE", async () => {
    const event = await Effect.runPromise(
      decodeCallEvent({
        event: "call.ended",
        room: "r-a",
        ended_at: "1500",
        duration_ms: "1000",
        audio: "r-a.wav",
        audio_started_at: "0",
      }),
    );
    expect(frame({ id: "2-1", event })).toContain('"audio_started_at":0');
  });
});

// fakeMongo yields the given docs or failure and records each find call.
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
  direction: "outbound",
  prompt: "Order a pizza.",
  startedAt: new Date(1000),
};

describe("callsSnapshot", () => {
  const run = (result: CallDoc[] | Error) =>
    Effect.runPromise(
      callsSnapshot.pipe(
        Effect.provideService(CallsConfig, settings),
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

describe("call routes", () => {
  it("serves the snapshot as JSON through the route", async () => {
    const handler = HttpApp.toWebHandler(
      HttpRouter.empty.pipe(
        HttpRouter.get("/calls", callsSnapshot),
        Effect.provideService(CallsConfig, settings),
        Effect.provideService(MongoClient, fakeMongo([activeDoc]).mongo),
      ),
    );
    const response = await handler(new Request("http://localhost/calls"));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual([
      {
        room: "r-a",
        status: "active",
        conversation_id: "conv-1",
        from: "+15550001111",
        to: "+15550002222",
        direction: "outbound",
        prompt: "Order a pizza.",
        started_at: 1000,
      },
    ]);
  });

  it("sends the SSE preamble and replays Last-Event-ID with proxy-safe headers", async () => {
    const xrange = vi.fn(async () => [
      ["2-0", ["event", "call.started", "room", "r-a", "started_at", "123"]],
    ]);
    const handler = HttpApp.toWebHandler(
      HttpRouter.empty.pipe(
        HttpRouter.get("/calls/events", callsFeed),
        Effect.provideService(RedisClient, {
          xrange,
        } as unknown as RedisClient),
        Effect.provide(CallFeed.Default),
        Effect.provideService(CallsConfig, settings),
      ),
    );
    const response = await handler(
      new Request("http://localhost/calls/events", {
        headers: { "Last-Event-ID": "1-0" },
      }),
    );
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.headers.get("cache-control")).toBe(
      "no-cache, no-transform",
    );
    expect(response.headers.get("x-accel-buffering")).toBe("no");
    const reader = response.body!.getReader();
    let body = "";
    const decoder = new TextDecoder();
    try {
      while (!body.includes('data: {"event":"call.started"')) {
        const next = await reader.read();
        if (next.done) throw new Error("SSE ended before replay");
        body += decoder.decode(next.value, { stream: true });
      }
      expect(body).toBe(
        'retry: 3000\n\nid: 2-0\nevent: call.started\ndata: {"event":"call.started","room":"r-a","started_at":123}\n\n',
      );
      expect(xrange).toHaveBeenCalledWith("ringback:calls", "(1-0", "+");
    } finally {
      await reader.cancel();
    }
  });
});

it("ends the event stream with a sanitized error when replay fails", async () => {
  const handler = HttpApp.toWebHandler(
    callsFeed.pipe(
      Effect.provideService(RedisClient, {
        xrange: () => Promise.reject(new Error("private Redis credentials")),
      } as unknown as RedisClient),
      Effect.provide(CallFeed.Default),
      Effect.provideService(CallsConfig, settings),
    ),
  );
  const response = await handler(
    new Request("http://localhost/calls/events", {
      headers: { "Last-Event-ID": "1-0" },
    }),
  );
  await expect(response.text()).rejects.toThrow("internal");
});

it("applies the configured snapshot limit to Mongo", async () => {
  const { mongo, finds } = fakeMongo([]);
  const handler = HttpApp.toWebHandler(
    callsSnapshot.pipe(
      Effect.provideService(MongoClient, mongo),
      Effect.provide(CallsConfig.Default),
      Effect.withConfigProvider(
        ConfigProvider.fromMap(
          new Map([["RINGBACK_CALLS_SNAPSHOT_LIMIT", "7"]]),
        ),
      ),
    ),
  );
  const response = await handler(new Request("http://localhost/calls"));
  expect(response.status).toBe(200);
  expect(finds).toEqual([
    {
      filter: {},
      options: { projection: { _id: 0 }, sort: { startedAt: -1 }, limit: 7 },
    },
  ]);
});

it("uses the configured reconnect delay and keepalive interval", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const response = yield* callsFeed;
        if (response.body._tag !== "Stream")
          throw new Error("Expected an SSE stream");
        const pull = yield* Stream.toPull(
          Stream.decodeText(response.body.stream),
        );
        const preamble = yield* pull;
        expect(Chunk.toReadonlyArray(preamble).join("")).toBe("retry: 900\n\n");
        const next = yield* Effect.fork(pull);
        yield* TestClock.adjust(24);
        expect(Option.isNone(yield* Fiber.poll(next))).toBe(true);
        yield* TestClock.adjust(1);
        expect(Chunk.toReadonlyArray(yield* Fiber.join(next)).join("")).toBe(
          ": ka\n\n",
        );
      }),
    ).pipe(
      Effect.provideService(
        HttpServerRequest.HttpServerRequest,
        HttpServerRequest.fromWeb(new Request("http://localhost/calls/events")),
      ),
      Effect.provideService(RedisClient, {
        xrange: vi.fn(),
      } as unknown as RedisClient),
      Effect.provide(CallFeed.Default),
      Effect.provide(CallsConfig.Default),
      Effect.withConfigProvider(
        ConfigProvider.fromMap(
          new Map([
            ["RINGBACK_CALLS_RETRY_MS", "900"],
            ["RINGBACK_CALLS_KEEPALIVE_MS", "25"],
          ]),
        ),
      ),
      Effect.provide(TestContext.TestContext),
    ),
  );
});
