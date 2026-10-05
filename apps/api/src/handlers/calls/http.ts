import { HttpServerRequest, HttpServerResponse } from "@effect/platform";
import { Effect, Schedule, Stream } from "effect";
import { MongoClient } from "../../clients/mongo.js";
import { RedisClient } from "../../clients/redis.js";
import { CallFeed, type FeedEvent } from "../../pipeline/feed.js";
import { events, listCalls } from "./calls.js";
import { CallsConfig } from "./config.js";
import { logCallsError } from "./errors.js";

// KEEPALIVE comments stop idle proxies from reaping the connection.
const KEEPALIVE = ": ka\n\n";

// frame renders one event as an SSE message addressed by its stream entry id.
export const frame = (e: FeedEvent): string =>
  `id: ${e.id}\nevent: ${e.event.event}\ndata: ${JSON.stringify(e.event)}\n\n`;

// callsFeed streams call lifecycle events, resuming from Last-Event-ID on reconnect.
export const callsFeed = Effect.gen(function* () {
  const settings = yield* CallsConfig;
  const request = yield* HttpServerRequest.HttpServerRequest;
  const redis = yield* RedisClient;
  const feed = yield* CallFeed;
  const keepalives = Stream.fromSchedule(
    Schedule.spaced(settings.keepaliveMs),
  ).pipe(Stream.map(() => KEEPALIVE));
  // the retry line flushes headers right away and tunes EventSource's reconnect delay
  const body = Stream.succeed(`retry: ${settings.retryMs}\n\n`).pipe(
    Stream.concat(
      events(redis, feed, request.headers["last-event-id"]).pipe(
        Stream.tapError(logCallsError),
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

// callsSnapshot serves GET /calls, a point-in-time snapshot of the calls collection.
export const callsSnapshot = Effect.gen(function* () {
  const mongo = yield* MongoClient;
  return yield* HttpServerResponse.json(yield* listCalls(mongo));
}).pipe(
  Effect.catchAll((error) =>
    logCallsError(error).pipe(
      Effect.zipRight(
        HttpServerResponse.json({ error: "internal" }, { status: 500 }),
      ),
    ),
  ),
);
