import { HttpServerRequest, HttpServerResponse } from "@effect/platform";
import { Effect, PubSub, Schedule, Stream } from "effect";
import type { Redis } from "ioredis";
import { CallStream, decodeCallEvent, entryFields } from "../events/index.js";
import { CallFeed, type FeedEvent } from "../pipeline/feed.js";
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

// feed streams call lifecycle events, resuming from Last-Event-ID on reconnect.
export const feed = Effect.gen(function* () {
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
