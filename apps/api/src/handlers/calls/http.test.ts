import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HttpApp,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
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
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  MongoClient,
  type RequestDoc,
  type CallDoc,
  type TurnDoc,
} from "../../clients/mongo.js";
import { type CallEvent, decodeCallEvent } from "../../events/index.js";
import { RedisClient } from "../../clients/redis.js";
import { StripeClient } from "../../clients/stripe.js";
import { LiveKitClient } from "../../clients/livekit.js";
import { CallFeed } from "../../pipeline/feed.js";
import { router } from "../../router.js";
import { AudioConfig } from "../audio/config.js";
import { CallsConfig } from "./config.js";
import { PaymentConfig } from "../payments/config.js";
import { newAccessToken, newCallAccess } from "../payments/access.js";
import { CALL_COOKIE, callsFeed, callsSnapshot, frame } from "./http.js";

const tokenA = newAccessToken();
const tokenB = newAccessToken();
const settings = PaymentConfig.make({
  amount: 50,
  currency: "usd",
  environment: "production",
  requireTerms: false,
  publicApiUrl: "https://ringback.test/api",
  publicWebUrl: "https://ringback.test",
});

const fixture = (id: string, token: string): RequestDoc => ({
  _id: id,
  to: "+15551234567",
  prompt: `Task for ${id}`,
  inputHash: "input",
  requestSnapshotHash: "snapshot",
  amount: 50,
  currency: "usd",
  maxDuration: 1800,
  policyVersion: "v1",
  requireTerms: false,
  environment: "production",
  createdAt: new Date(),
  expiresAt: new Date(Date.now() + 35 * 60_000),
  access: newCallAccess(token, new Date()),
  status: "unpaid",
  room: `room-${id}`,
  checkout: {
    id: "cs-private",
    url: "https://checkout.stripe.com/private",
    accountId: "acct-private",
    livemode: true,
  },
  purchaseId: "purchase-private",
});

let directory = "";
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "ringback-private-"));
  await writeFile(join(directory, "a.wav"), Buffer.from([1, 2, 3, 4, 5]));
  await writeFile(join(directory, "b.wav"), Buffer.from([9, 8, 7, 6, 5]));
});
afterAll(() => rm(directory, { force: true, recursive: true }));

const harness = async (keepaliveMs = 15000, retryMs = 3000) => {
  const records = [fixture("a", tokenA), fixture("b", tokenB)];
  const calls: CallDoc[] = records.map((r) => ({
    room: r.room,
    status: "ended",
    audio: `${r._id}.wav`,
    conversationId: "provider-private",
    startedAt: new Date(1000),
    endedAt: new Date(2000),
    durationMs: 1000,
    audioStartedAt: new Date(900),
  }));
  const turns: TurnDoc[] = records.map((r) => ({
    room: r.room,
    seq: 1,
    role: "agent",
    text: `Transcript ${r._id}`,
    at: new Date(1100),
  }));
  const findCall = vi.fn(
    async ({ room }: { room: string }) =>
      calls.find((c) => c.room === room) ?? null,
  );
  const findTurns = vi.fn(({ room }: { room: string }) => ({
    toArray: async () => turns.filter((t) => t.room === room),
  }));
  const mongo = {
    requests: {
      findOne: vi.fn(
        async ({ _id }: { _id: string }) =>
          records.find((r) => r._id === _id) ?? null,
      ),
    },
    calls: { findOne: findCall },
    turns: { find: findTurns },
  } as unknown as MongoClient;
  const xrange = vi.fn(async () => [
    [
      "2-0",
      [
        "event",
        "call.turn",
        "room",
        "room-b",
        "seq",
        "1",
        "role",
        "agent",
        "text",
        "Secret B",
        "at",
        "1000",
      ],
    ],
    [
      "3-0",
      [
        "event",
        "call.turn",
        "room",
        "room-a",
        "seq",
        "1",
        "role",
        "agent",
        "text",
        "Hello A",
        "at",
        "1100",
      ],
    ],
  ]);
  const feed = await Effect.runPromise(
    Effect.gen(function* () {
      return yield* CallFeed;
    }).pipe(Effect.provide(CallFeed.Default)),
  );
  const handler = HttpApp.toWebHandler(
    router.pipe(
      Effect.provideService(MongoClient, mongo),
      Effect.provideService(RedisClient, { xrange } as unknown as RedisClient),
      Effect.provideService(CallFeed, feed),
      Effect.provideService(PaymentConfig, settings),
      Effect.provideService(
        CallsConfig,
        CallsConfig.make({ snapshotLimit: 100, keepaliveMs, retryMs }),
      ),
      Effect.provideService(
        AudioConfig,
        AudioConfig.make({ directory: Option.some(directory) }),
      ),
      Effect.provideService(StripeClient, {} as StripeClient),
      Effect.provideService(LiveKitClient, {} as LiveKitClient),
      Effect.provide(NodeFileSystem.layer),
    ),
  );
  const request = (
    path: string,
    headers: Record<string, string> = {},
    method = "GET",
  ) =>
    handler(new Request(`https://ringback.test${path}`, { headers, method }));
  return { records, calls, turns, findCall, findTurns, feed, xrange, request };
};

const bearer = (token = tokenA) => ({ Authorization: `Bearer ${token}` });
const cookie = (token = tokenA) => ({ Cookie: `${CALL_COOKIE}=${token}` });
const suffixes = ["", "/turns", "/audio"];

describe("call authorization through the application router", () => {
  it.each(suffixes)(
    "requires credentials before reading results at %s",
    async (suffix) => {
      const h = await harness();
      const response = await h.request(`/call/a${suffix}`);
      expect(response.status).toBe(401);
      expect(response.headers.get("cache-control")).toContain("no-store");
      expect(h.findCall).not.toHaveBeenCalled();
      expect(h.findTurns).not.toHaveBeenCalled();
    },
  );

  it.each(suffixes)(
    "denies cross-call bearer and cookie access at %s",
    async (suffix) => {
      const h = await harness();
      for (const credentials of [bearer(tokenB), cookie(tokenB)]) {
        const response = await h.request(`/call/a${suffix}`, credentials);
        expect(response.status).toBe(404);
        expect(await response.json()).toEqual({ error: "not_found" });
      }
      expect(h.findCall).not.toHaveBeenCalled();
      expect(h.findTurns).not.toHaveBeenCalled();
    },
  );

  it.each(suffixes)(
    "denies expired, revoked, and unknown calls at %s",
    async (suffix) => {
      const h = await harness();
      h.records[0]!.access!.revokedAt = new Date();
      expect((await h.request(`/call/a${suffix}`, bearer())).status).toBe(404);
      delete h.records[0]!.access!.revokedAt;
      h.records[0]!.access!.expiresAt = new Date(0);
      expect((await h.request(`/call/a${suffix}`, cookie())).status).toBe(404);
      expect((await h.request(`/call/missing${suffix}`, bearer())).status).toBe(
        404,
      );
    },
  );

  it("never falls back from an explicit invalid bearer to a valid cookie", async () => {
    const h = await harness();
    expect(
      (
        await h.request("/call/a", {
          ...cookie(),
          Authorization: "Bearer malformed",
        })
      ).status,
    ).toBe(401);
    expect(
      (await h.request("/call/a", { ...cookie(), ...bearer(tokenB) })).status,
    ).toBe(404);
    expect((await h.request(`/call/a?token=${tokenA}`)).status).toBe(401);
  });

  it("returns only safe metadata and derives the room from the authorized request", async () => {
    const h = await harness();
    const response = await h.request("/call/a?room=room-b", cookie());
    expect(response.status).toBe(200);
    expect(response.headers.get("x-robots-tag")).toContain("noindex");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    const body = await response.json();
    expect(body).toMatchObject({
      call_id: "a",
      prompt: "Task for a",
      call: { status: "ended", audio_available: true },
    });
    expect(h.findCall).toHaveBeenCalledWith({ room: "room-a" });
    for (const secret of [
      tokenA,
      "purchase-private",
      "acct-private",
      "provider-private",
      "a.wav",
      "tokenHash",
    ])
      expect(JSON.stringify(body)).not.toContain(secret);
    h.calls.splice(0, 1);
    const waiting = await (await h.request("/call/a", bearer())).json();
    expect(waiting.call).toBeNull();
    expect(waiting.checkout_url).toBe("https://checkout.stripe.com/private");
  });

  it("returns each transcript only to its own credential", async () => {
    const h = await harness();
    for (const [id, token] of [
      ["a", tokenA],
      ["b", tokenB],
    ]) {
      const response = await h.request(`/call/${id}/turns`, bearer(token));
      expect(await response.json()).toEqual([
        {
          room: `room-${id}`,
          seq: 1,
          role: "agent",
          text: `Transcript ${id}`,
          at: 1100,
        },
      ]);
    }
  });

  it("sanitizes a failed database read after authorization", async () => {
    const h = await harness();
    h.findCall.mockRejectedValueOnce(new Error("mongodb://private-password"));
    const response = await h.request("/call/a", bearer());
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "internal" });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("preserves authenticated audio ranges and protects missing-file responses", async () => {
    const h = await harness();
    const response = await h.request("/call/a/audio", {
      ...cookie(),
      Range: "bytes=1-3",
    });
    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe("bytes 1-3/5");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([
      2, 3, 4,
    ]);
    expect(
      (await h.request("/call/a/audio", { ...bearer(), Range: "bytes=99-" }))
        .status,
    ).toBe(416);
    h.calls[0]!.audio = "missing.wav";
    expect((await h.request("/call/a/audio", bearer())).status).toBe(404);
  });
});

const callsSettings = CallsConfig.make({
  snapshotLimit: 100,
  keepaliveMs: 15000,
  retryMs: 3000,
});

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
        Effect.provideService(CallsConfig, callsSettings),
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
        Effect.provideService(CallsConfig, callsSettings),
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
        Effect.provideService(CallsConfig, callsSettings),
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
      Effect.provideService(CallsConfig, callsSettings),
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
