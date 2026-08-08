import { randomUUID, timingSafeEqual } from "node:crypto";
import { HttpServerRequest, HttpServerResponse } from "@effect/platform";
import { Config, Effect, Option, PubSub, Schedule, Schema, Stream } from "effect";
import type { Redis } from "ioredis";
import type { SipClient } from "livekit-server-sdk";
import { CallStream, decodeCallEvent, entryFields } from "../events/index.js";
import { CallFeed, type FeedEvent } from "../pipeline/feed.js";
import { LiveKitClient } from "../clients/livekit.js";
import { MongoClient } from "../clients/mongo.js";
import { RedisClient } from "../clients/redis.js";

// PREAMBLE flushes headers right away and tunes EventSource's reconnect delay.
const PREAMBLE = "retry: 3000\n\n";

// KEEPALIVE comments stop idle proxies from reaping the connection.
const KEEPALIVE = ": ka\n\n";
const KEEPALIVE_EVERY = "15 seconds";

// ENTRY_ID is the shape of a Redis stream entry id (ms-seq).
const ENTRY_ID = /^\d+-\d+$/;

// frame renders one event as an SSE message addressed by its stream entry id.
export const frame = (e: FeedEvent): string =>
  `id: ${e.id}\nevent: ${e.event.event}\ndata: ${JSON.stringify(e.event)}\n\n`;

// isAfter reports whether stream entry id a is newer than b.
export const isAfter = (a: string, b: string): boolean => {
  const [ams = 0, aseq = 0] = a.split("-").map(Number);
  const [bms = 0, bseq = 0] = b.split("-").map(Number);
  return ams === bms ? aseq > bseq : ams > bms;
};

// replayAfter reads the entries a reconnecting client missed, oldest first.
const replayAfter = (redis: Redis, lastId: string) =>
  Effect.gen(function* () {
    const entries = yield* Effect.tryPromise(() =>
      redis.xrange(CallStream, `(${lastId}`, "+"),
    );
    const out: FeedEvent[] = [];
    for (const [id, fields] of entries) {
      const decoded = yield* decodeCallEvent(entryFields(fields)).pipe(
        Effect.either,
      );
      if (decoded._tag === "Left") {
        yield* Effect.logWarning(`sse: skipping undecodable entry ${id}`);
        continue;
      }
      out.push({ id, event: decoded.right });
    }
    return out;
  });

// events replays anything past lastEventId, then follows the live feed.
export const events = (
  redis: Redis,
  feed: CallFeed,
  lastEventId: string | undefined,
) =>
  Stream.unwrapScoped(
    Effect.gen(function* () {
      // subscribe before replaying so nothing falls between XRANGE and the feed
      const sub = yield* PubSub.subscribe(feed);
      const since =
        lastEventId !== undefined && ENTRY_ID.test(lastEventId)
          ? lastEventId
          : undefined;
      const replay =
        since === undefined ? [] : yield* replayAfter(redis, since);
      // the feed buffers from before XRANGE ran, so drop what the replay already sent
      const cutoff = replay.at(-1)?.id ?? since;
      const live =
        cutoff === undefined
          ? Stream.fromQueue(sub)
          : Stream.fromQueue(sub).pipe(
              Stream.filter((e) => isAfter(e.id, cutoff)),
            );
      return Stream.fromIterable(replay).pipe(Stream.concat(live));
    }),
  );

// callsFeed streams call lifecycle events, resuming from Last-Event-ID on reconnect.
export const callsFeed = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const redis = yield* RedisClient;
  const feed = yield* CallFeed;
  const keepalives = Stream.fromSchedule(Schedule.spaced(KEEPALIVE_EVERY)).pipe(
    Stream.map(() => KEEPALIVE),
  );
  const body = Stream.succeed(PREAMBLE).pipe(
    Stream.concat(
      events(redis, feed, request.headers["last-event-id"]).pipe(
        Stream.map(frame),
        Stream.merge(keepalives),
      ),
    ),
  );
  return HttpServerResponse.stream(Stream.encodeText(body), {
    contentType: "text/event-stream",
    headers: {
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
    },
  });
});

// SNAPSHOT_LIMIT caps GET /calls at the newest calls by started_at.
const SNAPSHOT_LIMIT = 100;

// CallSnapshot encodes a CallDoc into the SSE wire dialect: snake_case, unix-ms.
export const CallSnapshot = Schema.Struct({
  room: Schema.String,
  status: Schema.Literal("active", "ended"),
  conversationId: Schema.optional(Schema.String).pipe(
    Schema.fromKey("conversation_id"),
  ),
  from: Schema.optional(Schema.String),
  to: Schema.optional(Schema.String),
  direction: Schema.optional(Schema.String),
  startedAt: Schema.optional(Schema.DateFromNumber).pipe(
    Schema.fromKey("started_at"),
  ),
  endedAt: Schema.optional(Schema.DateFromNumber).pipe(
    Schema.fromKey("ended_at"),
  ),
  durationMs: Schema.optional(Schema.Number).pipe(
    Schema.fromKey("duration_ms"),
  ),
});

const encodeSnapshots = Schema.encode(Schema.Array(CallSnapshot));

// listCalls reads the newest calls and encodes them for the wire.
export const listCalls = (mongo: MongoClient) =>
  Effect.gen(function* () {
    const docs = yield* Effect.tryPromise(() =>
      mongo.calls
        .find(
          {},
          {
            projection: { _id: 0 },
            sort: { startedAt: -1 },
            limit: SNAPSHOT_LIMIT,
          },
        )
        .toArray(),
    );
    return yield* encodeSnapshots(docs);
  });

// callsSnapshot serves GET /calls: a point-in-time snapshot of the calls collection.
export const callsSnapshot = Effect.gen(function* () {
  const mongo = yield* MongoClient;
  return yield* HttpServerResponse.json(yield* listCalls(mongo));
}).pipe(
  Effect.catchAll((error) =>
    Effect.logError("calls: snapshot failed", error).pipe(
      Effect.zipRight(
        HttpServerResponse.json({ error: "internal" }, { status: 500 }),
      ),
    ),
  ),
);

// OUTBOUND_TRUNK_NAME is the trunk deploy/sip/outbound-trunk.json converges.
const OUTBOUND_TRUNK_NAME = "twilio-outbound";

// ApiKey is the shared secret guarding call placement, and leaving it unset disables the endpoint.
const ApiKey = Config.option(Config.string("RINGBACK_API_KEY"));

// PlaceCall is the POST /calls body carrying one E.164 destination.
const PlaceCall = Schema.Struct({
  to: Schema.String.pipe(Schema.pattern(/^\+[1-9]\d{6,14}$/)),
});
const decodeBody = Schema.decodeUnknown(PlaceCall);

// Sip is the slice of the LiveKit client that placing a call needs.
export type Sip = Pick<SipClient, "listSipOutboundTrunk" | "createSipParticipant">;

// authorized reports whether the header is exactly "Bearer <key>", in constant time.
export const authorized = (
  header: string | undefined,
  key: string,
): boolean => {
  const presented = Buffer.from(header ?? "");
  const expected = Buffer.from(`Bearer ${key}`);
  return (
    presented.length === expected.length &&
    timingSafeEqual(presented, expected)
  );
};

// place dials one number through the outbound trunk after checking the bearer key.
export const place = (
  sip: Sip,
  key: string | undefined,
  authorization: string | undefined,
  body: unknown,
) =>
  Effect.gen(function* () {
    if (key === undefined) {
      yield* Effect.logWarning("calls: RINGBACK_API_KEY unset, refusing to dial");
      return yield* HttpServerResponse.json({ error: "disabled" }, { status: 503 });
    }
    if (!authorized(authorization, key)) {
      return yield* HttpServerResponse.json(
        { error: "unauthorized" },
        { status: 401 },
      );
    }
    const parsed = yield* decodeBody(body).pipe(Effect.either);
    if (parsed._tag === "Left") {
      return yield* HttpServerResponse.json(
        { error: "to must be E.164, like +15551234567" },
        { status: 400 },
      );
    }
    const trunks = yield* Effect.tryPromise(() => sip.listSipOutboundTrunk());
    const trunk = trunks.find((t) => t.name === OUTBOUND_TRUNK_NAME);
    if (trunk === undefined) {
      yield* Effect.logError(
        `calls: outbound trunk ${OUTBOUND_TRUNK_NAME} not found`,
      );
      return yield* HttpServerResponse.json(
        { error: "no outbound trunk" },
        { status: 503 },
      );
    }
    // call- prefix makes the worker join and the attribute makes it read from/to as outbound
    const room = `call-${randomUUID()}`;
    yield* Effect.tryPromise(() =>
      sip.createSipParticipant(trunk.sipTrunkId, parsed.right.to, room, {
        participantIdentity: "sip-outbound",
        participantAttributes: { "ringback.direction": "outbound" },
      }),
    );
    yield* Effect.logInfo(`calls: dialing ${parsed.right.to} in ${room}`);
    return yield* HttpServerResponse.json({ room }, { status: 201 });
  });

// placeCall serves POST /calls, which dials one number as the agent behind RINGBACK_API_KEY.
export const placeCall = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const sip = yield* LiveKitClient;
  const key = yield* ApiKey;
  const body = yield* request.json;
  return yield* place(
    sip,
    Option.getOrUndefined(key),
    request.headers["authorization"],
    body,
  );
}).pipe(
  Effect.catchTag("RequestError", () =>
    HttpServerResponse.json({ error: "body must be JSON" }, { status: 400 }),
  ),
  Effect.catchAll((error) =>
    Effect.logError("calls: place failed", error).pipe(
      Effect.zipRight(
        HttpServerResponse.json({ error: "internal" }, { status: 500 }),
      ),
    ),
  ),
);
