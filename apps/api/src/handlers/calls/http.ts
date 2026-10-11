import {
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "@effect/platform";
import { Effect, Schedule, Stream } from "effect";
import { MongoClient } from "../../clients/mongo.js";
import { RedisClient } from "../../clients/redis.js";
import { CallFeed, type FeedEvent } from "../../pipeline/feed.js";
import type { CallEvent } from "../../events/index.js";
import { audioFor } from "../audio/http.js";
import { events, listCalls, subscribeEvents } from "./calls.js";
import { CallsConfig } from "./config.js";
import { logCallsError } from "./errors.js";
import {
  authorizeCallAccess,
  bearerToken,
  validAccessSecret,
} from "../payments/access.js";
import { PaymentConfig } from "../payments/config.js";
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

// The browser always talks to /api on its own origin, including in development.
export const bootstrapCallAccess = callResponse(
  Effect.gen(function* () {
    const http = yield* HttpServerRequest.HttpServerRequest;
    const settings = yield* PaymentConfig;
    if (http.headers.origin !== new URL(settings.publicWebUrl).origin)
      return yield* new PaymentError({ code: "unauthorized" });
    const token = yield* bearerToken(http.headers.authorization);
    if (!token) return yield* new PaymentError({ code: "unauthorized" });
    const { id = "" } = yield* HttpRouter.params;
    const record = yield* authorizeCallAccess(id, token);
    const response = yield* json({
      access_expires_at: record.access!.expiresAt.toISOString(),
    });
    return yield* HttpServerResponse.setCookie(response, CALL_COOKIE, token, {
      path: callCookiePath(id),
      httpOnly: true,
      secure: settings.environment === "production",
      sameSite: "lax",
      expires: record.access!.expiresAt,
    });
  }),
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

// Provider identifiers and filesystem names are not part of the call feed.
const safeEvent = (event: CallEvent) => {
  if (event.event === "call.started")
    return {
      event: event.event,
      room: event.room,
      started_at: event.started_at,
    };
  if (event.event === "call.ended")
    return {
      event: event.event,
      room: event.room,
      ended_at: event.ended_at,
      duration_ms: event.duration_ms,
      audio_available: !!event.audio,
      audio_started_at: event.audio_started_at,
    };
  return event;
};

// Split long grants into waits supported by the runtime's 32-bit timer.
const untilExpiry = (expiresAt: number): Effect.Effect<void> =>
  Effect.suspend(() => {
    const remaining = expiresAt - Date.now();
    return remaining <= 0
      ? Effect.void
      : Effect.sleep(Math.min(remaining, 86_400_000)).pipe(
          Effect.zipRight(untilExpiry(expiresAt)),
        );
  });

export const callEvents = callResponse(
  Effect.gen(function* () {
    const { record, token } = yield* httpCallAccess;
    const http = yield* HttpServerRequest.HttpServerRequest;
    const settings = yield* CallsConfig;
    const redis = yield* RedisClient;
    const feed = yield* CallFeed;
    const mongo = yield* MongoClient;
    const checkAccess = authorizeCallAccess(record._id, token).pipe(
      Effect.provideService(MongoClient, mongo),
    );
    const keepalives = Stream.fromSchedule(
      Schedule.spaced(Math.min(settings.keepaliveMs, 15000)),
    ).pipe(
      Stream.mapEffect(() => checkAccess),
      Stream.map(() => ": ka\n\n"),
    );
    const body = Stream.unwrapScoped(
      subscribeEvents(redis, feed, http.headers["last-event-id"]).pipe(
        Effect.map((updates) =>
          // A snapshot taken after ready cannot miss updates before subscription.
          Stream.succeed(
            `retry: ${settings.retryMs}\n\nevent: ready\ndata: {}\n\n`,
          ).pipe(
            Stream.concat(
              updates.pipe(
                Stream.filter(({ event }) => event.room === record.room),
                Stream.tap(() => checkAccess),
                Stream.map(
                  ({ id, event }) =>
                    `id: ${id}\nevent: ${event.event}\ndata: ${JSON.stringify(safeEvent(event))}\n\n`,
                ),
              ),
            ),
          ),
        ),
      ),
    ).pipe(
      Stream.merge(keepalives),
      Stream.interruptWhen(untilExpiry(record.access!.expiresAt.getTime())),
      Stream.catchAll(() =>
        Stream.succeed("event: access.unavailable\ndata: {}\n\n"),
      ),
    );
    return HttpServerResponse.stream(Stream.encodeText(body), {
      contentType: "text/event-stream",
      headers: { "x-accel-buffering": "no" },
    });
  }),
);
