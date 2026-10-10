import {
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "@effect/platform";
import { Effect, Schedule, Stream } from "effect";
import { MongoClient } from "../../clients/mongo.js";
import { RedisClient } from "../../clients/redis.js";
import { CallFeed, type FeedEvent } from "../../pipeline/feed.js";
import { audioFor } from "../audio/http.js";
import { events, listCalls } from "./calls.js";
import { CallsConfig } from "./config.js";
import { logCallsError } from "./errors.js";
import {
  authorizeCallAccess,
  bearerToken,
  validAccessSecret,
} from "../payments/access.js";
import { PaymentError } from "../payments/errors.js";
import { json, paymentResponse } from "../payments/http.js";
import { listTurns } from "../turns/turns.js";

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

// Each browser grant uses the same cookie name at a different call-specific path.
export const CALL_COOKIE = "ringback_access";
export const callCookiePath = (id: string) =>
  `/api/call/${encodeURIComponent(id)}`;

// Explicit Authorization always wins, including when it is invalid.
const httpCallAccess = Effect.gen(function* () {
  const { id = "" } = yield* HttpRouter.params;
  const http = yield* HttpServerRequest.HttpServerRequest;
  const token =
    http.headers.authorization !== undefined
      ? yield* bearerToken(http.headers.authorization)
      : http.cookies[CALL_COOKIE];
  if (!token || !validAccessSecret(token))
    return yield* new PaymentError({ code: "unauthorized" });
  const record = yield* authorizeCallAccess(id, token);
  return { record, token };
});

const callHeaders = {
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-robots-tag": "noindex, nofollow, noarchive",
};

const callResponse = <E, R>(
  effect: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
) =>
  paymentResponse("call-access", effect).pipe(
    Effect.map(HttpServerResponse.setHeaders(callHeaders)),
  );

// Only explicitly selected call-facing fields can leave this boundary.
export const callSnapshot = callResponse(
  Effect.gen(function* () {
    const { record } = yield* httpCallAccess;
    const mongo = yield* MongoClient;
    const call = yield* Effect.tryPromise(() =>
      mongo.calls.findOne({ room: record.room }),
    );
    return yield* json({
      call_id: record._id,
      status: record.status,
      room: record.dialedAt ? record.room : null,
      error: record.error ?? null,
      to: record.to,
      prompt: record.prompt,
      amount: record.amount,
      currency: record.currency,
      max_duration_seconds: record.maxDuration,
      created_at: record.createdAt.toISOString(),
      access_expires_at: record.access!.expiresAt.toISOString(),
      checkout_expires_at: record.expiresAt.toISOString(),
      checkout_url:
        record.status === "unpaid" && record.expiresAt.getTime() > Date.now()
          ? (record.checkout?.url ?? null)
          : null,
      call: call
        ? {
            status: call.status,
            started_at: call.startedAt?.getTime(),
            ended_at: call.endedAt?.getTime(),
            duration_ms: call.durationMs,
            audio_available: call.status === "ended" && !!call.audio,
            audio_started_at: call.audioStartedAt?.getTime(),
          }
        : null,
    });
  }),
);

export const callTurns = callResponse(
  Effect.gen(function* () {
    const { record } = yield* httpCallAccess;
    const mongo = yield* MongoClient;
    return yield* json(yield* listTurns(mongo, record.room));
  }),
);

export const callAudio = callResponse(
  Effect.gen(function* () {
    const { record } = yield* httpCallAccess;
    const http = yield* HttpServerRequest.HttpServerRequest;
    return yield* audioFor(record.room, http.headers.range);
  }),
);
