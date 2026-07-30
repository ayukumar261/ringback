import { Effect, Layer, PubSub } from "effect";
import type { Redis } from "ioredis";
import {
  applyCallEvent,
  CallStream,
  decodeCallEvent,
  entryFields,
} from "../events/index.js";
import { CallFeed } from "./feed.js";
import { MongoClient } from "../clients/mongo.js";
import { RedisClient } from "../clients/redis.js";

const GROUP = "materializer";
const CONSUMER = "api";
const CURSOR_ID = "materializer";
const BATCH = 64;
const BLOCK_MS = 5000;

// Entry is one stream entry as delivered by XREADGROUP.
interface Entry {
  id: string;
  fields: ReadonlyArray<string> | null; // null when trimmed away while pending
}

// toEntries flattens one XREADGROUP reply into entries for our single stream.
const toEntries = (reply: unknown): Entry[] => {
  if (!reply) {
    return [];
  }
  const out: Entry[] = [];
  const streams = reply as ReadonlyArray<
    [string, ReadonlyArray<[string, string[] | null]>]
  >;
  for (const [, entries] of streams) {
    for (const [id, fields] of entries) {
      out.push({ id, fields });
    }
  }
  return out;
};

// ensureGroup creates the consumer group from the stream's start, tolerating reruns.
const ensureGroup = (redis: Redis) =>
  Effect.tryPromise(() =>
    redis.xgroup("CREATE", CallStream, GROUP, "0", "MKSTREAM"),
  ).pipe(
    Effect.catchAll((e) =>
      `${e.message} ${String(e.cause)}`.includes("BUSYGROUP")
        ? Effect.void
        : Effect.fail(e),
    ),
  );

// processEntries applies a batch, fans it out, records the cursor, then acks — in that order.
const processEntries = (
  mongo: MongoClient,
  redis: Redis,
  feed: CallFeed,
  entries: ReadonlyArray<Entry>,
) =>
  Effect.gen(function* () {
    const lastId = entries.at(-1)?.id;
    if (lastId === undefined) {
      return;
    }
    for (const entry of entries) {
      if (entry.fields === null) {
        continue;
      }
      const decoded = yield* decodeCallEvent(entryFields(entry.fields)).pipe(
        Effect.either,
      );
      if (decoded._tag === "Left") {
        yield* Effect.logWarning(
          `materializer: skipping undecodable entry ${entry.id}`,
        );
        continue;
      }
      yield* applyCallEvent(mongo, decoded.right);
      yield* PubSub.publish(feed, { id: entry.id, event: decoded.right });
    }
    yield* Effect.tryPromise(() =>
      mongo.meta.updateOne(
        { _id: CURSOR_ID },
        { $set: { lastAppliedId: lastId } },
        { upsert: true },
      ),
    );
    yield* Effect.tryPromise(() =>
      redis.xack(CallStream, GROUP, ...entries.map((e) => e.id)),
    );
  });

// recoverPending replays entries delivered to us but never acked before a crash.
const recoverPending = (mongo: MongoClient, redis: Redis, feed: CallFeed) =>
  Effect.gen(function* () {
    for (;;) {
      const entries = toEntries(
        yield* Effect.tryPromise(() =>
          redis.xreadgroup(
            "GROUP",
            GROUP,
            CONSUMER,
            "COUNT",
            BATCH,
            "STREAMS",
            CallStream,
            "0",
          ),
        ),
      );
      if (entries.length === 0) {
        return;
      }
      yield* Effect.logInfo(
        `materializer: recovering ${entries.length} pending entries`,
      );
      yield* processEntries(mongo, redis, feed, entries);
    }
  });

// readBatch long-polls the stream for entries never delivered to the group.
const readBatch = (redis: Redis) =>
  Effect.tryPromise(() =>
    redis.xreadgroup(
      "GROUP",
      GROUP,
      CONSUMER,
      "COUNT",
      BATCH,
      "BLOCK",
      BLOCK_MS,
      "STREAMS",
      CallStream,
      ">",
    ),
  ).pipe(Effect.map(toEntries));

// MaterializerLive tails the call stream and keeps Mongo's call records current.
export const MaterializerLive = Layer.scopedDiscard(
  Effect.gen(function* () {
    const base = yield* RedisClient;
    const mongo = yield* MongoClient;
    const feed = yield* CallFeed;
    const redis = yield* Effect.acquireRelease(
      Effect.sync(() => base.duplicate()),
      (r) => Effect.sync(() => r.disconnect()),
    );
    const run = Effect.gen(function* () {
      yield* ensureGroup(redis);
      yield* recoverPending(mongo, redis, feed);
      yield* Effect.forever(
        readBatch(redis).pipe(
          Effect.flatMap((entries) =>
            processEntries(mongo, redis, feed, entries),
          ),
        ),
      );
    });
    yield* run.pipe(
      Effect.catchAllCause((cause) =>
        Effect.logWarning("materializer: failed, restarting", cause).pipe(
          Effect.zipRight(Effect.sleep("1 second")),
        ),
      ),
      Effect.forever,
      Effect.forkScoped,
    );
  }),
);
