import { Effect, PubSub, Stream } from "effect";
import type { Redis } from "ioredis";
import {
  CallStream,
  decodeCallEvent,
  entryFields,
} from "../../events/index.js";
import { CallFeed, type FeedEvent } from "../../pipeline/feed.js";
import { CallsError } from "./errors.js";
import { eventCursor } from "./schema.js";

// isAfter reports whether stream entry id a is newer than b.
export const isAfter = (a: string, b: string): boolean => {
  const [ams = 0, aseq = 0] = a.split("-").map(Number);
  const [bms = 0, bseq = 0] = b.split("-").map(Number);
  return ams === bms ? aseq > bseq : ams > bms;
};

// replayAfter reads the entries a reconnecting client missed, oldest first.
const replayAfter = (redis: Redis, lastId: string) =>
  Effect.gen(function* () {
    const entries = yield* Effect.tryPromise({
      try: () => redis.xrange(CallStream, `(${lastId}`, "+"),
      catch: () => new CallsError({ code: "internal" }),
    });
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

// subscribeEvents attaches before reading history, closing the replay/live gap.
export const subscribeEvents = (
  redis: Redis,
  feed: CallFeed,
  lastEventId: string | undefined,
) =>
  Effect.gen(function* () {
    // subscribe before replaying so nothing falls between XRANGE and the feed
    const sub = yield* PubSub.subscribe(feed);
    const since = eventCursor(lastEventId);
    const replay = since === undefined ? [] : yield* replayAfter(redis, since);
    // the feed buffers from before XRANGE ran, so drop what the replay already sent
    const cutoff = replay.at(-1)?.id ?? since;
    const live =
      cutoff === undefined
        ? Stream.fromQueue(sub)
        : Stream.fromQueue(sub).pipe(
            Stream.filter((e) => isAfter(e.id, cutoff)),
          );
    return Stream.fromIterable(replay).pipe(Stream.concat(live));
  });

// events replays anything past lastEventId, then follows the live feed.
export const events = (
  redis: Redis,
  feed: CallFeed,
  lastEventId: string | undefined,
) => Stream.unwrapScoped(subscribeEvents(redis, feed, lastEventId));
