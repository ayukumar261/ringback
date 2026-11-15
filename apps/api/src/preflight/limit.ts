import { createHash, randomUUID } from "node:crypto";
import { Effect } from "effect";
import type { Redis } from "ioredis";
import type { Collection } from "mongodb";
import { MongoClient, type RequestDoc } from "../clients/mongo.js";
import { RedisClient } from "../clients/redis.js";
import { environmentConfig, type Environment } from "../environment.js";
import { FreeCallLimitError, PreflightError } from "./errors.js";

const WINDOW_MS = 24 * 60 * 60_000;
const LIMIT = 3;
const RESERVATION_MS = 120_000;

type Entry = { _id: string; createdAt: number };
type Snapshot = { revision: string; entries: Entry[] };

// A payment or dispatch failure may invalidate a snapshot while Mongo is being
// read. Only publish the result if no such change has happened in the meantime.
const cacheSnapshot = `
if (redis.call('GET', KEYS[2]) or '') ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[1], ARGV[2], 'PX', ARGV[3])
return 1
`;

export const makeCallLimit = (
  redis: Pick<Redis, "mget" | "eval" | "set">,
  requests: Pick<Collection<RequestDoc>, "find">,
  environment: Environment,
) => {
  const prefix = `call-limit:${environment}`;
  const revisionKey = `${prefix}:revision`;
  const unavailable = () =>
    new PreflightError({ code: "call_limit_unavailable" });
  const bounded = <A>(run: () => Promise<A>) =>
    Effect.tryPromise({ try: run, catch: unavailable }).pipe(
      Effect.timeoutFail({ duration: "3 seconds", onTimeout: unavailable }),
    );

  return {
    check: (number: string, requestId?: string) =>
      bounded(async () => {
        const key = `${prefix}:${number}`;
        for (let attempt = 0; attempt < 3; attempt++) {
          const [cached, value] = await redis.mget(key, revisionKey);
          const revision = value ?? "";
          let snapshot = cached ? (JSON.parse(cached) as Snapshot) : null;
          if (!snapshot || snapshot.revision !== revision) {
            const records = await requests
              .find(
                {
                  to: number,
                  environment,
                  status: { $in: ["paid", "dialing", "dialed"] },
                  createdAt: { $gt: new Date(Date.now() - WINDOW_MS) },
                },
                { projection: { _id: 1, createdAt: 1 } },
              )
              .toArray();
            snapshot = {
              revision,
              entries: records.map(({ _id, createdAt }) => ({
                _id,
                createdAt: createdAt.getTime(),
              })),
            };
            const saved = await redis.eval(
              cacheSnapshot,
              2,
              key,
              revisionKey,
              revision,
              JSON.stringify(snapshot),
              WINDOW_MS,
            );
            if (saved !== 1) continue;
          }
          const cutoff = Date.now() - WINDOW_MS;
          return (
            snapshot.entries.filter(
              (entry) => entry._id !== requestId && entry.createdAt > cutoff,
            ).length < LIMIT
          );
        }
        throw new Error("Call limit changed during each read");
      }).pipe(
        Effect.flatMap((allowed) =>
          allowed
            ? Effect.void
            : Effect.fail(new PreflightError({ code: "daily_call_limit" })),
        ),
      ),

    // One environment-wide revision also invalidates destinations affected by
    // stale dispatch claims, without scanning or deleting Redis keys.
    invalidate: bounded(async () => {
      await redis.set(revisionKey, randomUUID(), "PX", WINDOW_MS);
    }),
  };
};

// Server time keeps every dispatcher on the same rolling window. A reservation
// expires with a stale dispatch claim; completed calls count for 24 hours.
const reserveSlot = `
local time = redis.call('TIME')
local now = time[1] * 1000 + math.floor(time[2] / 1000)
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now - tonumber(ARGV[2]))
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', now - tonumber(ARGV[3]))
if redis.call('ZSCORE', KEYS[1], ARGV[1]) or redis.call('ZSCORE', KEYS[2], ARGV[1]) then return 1 end
if redis.call('ZCARD', KEYS[1]) + redis.call('ZCARD', KEYS[2]) >= tonumber(ARGV[4]) then return 0 end
redis.call('ZADD', KEYS[1], now, ARGV[1])
redis.call('PEXPIRE', KEYS[1], ARGV[2])
return 1
`;

const completeSlot = `
if redis.call('ZSCORE', KEYS[2], ARGV[1]) then return 1 end
if not redis.call('ZSCORE', KEYS[1], ARGV[1]) then return 0 end
local time = redis.call('TIME')
local now = time[1] * 1000 + math.floor(time[2] / 1000)
redis.call('ZADD', KEYS[2], now, ARGV[1])
redis.call('PEXPIRE', KEYS[2], ARGV[2])
redis.call('ZREM', KEYS[1], ARGV[1])
return 1
`;

const releaseSlot = `
redis.call('ZREM', KEYS[1], ARGV[1])
redis.call('ZREM', KEYS[2], ARGV[1])
return 1
`;

// Only the hash of the normalized email appears in Redis keys. Request IDs make
// reservation, completion, and cleanup safe to repeat without using extra slots.
export const makeFreeCallLimit = (
  redis: Pick<Redis, "eval">,
  environment: Environment,
) => {
  const unavailable = () =>
    new FreeCallLimitError({ code: "free_call_limit_unavailable" });
  const run = (script: string, email: string, ...args: (string | number)[]) => {
    const digest = createHash("sha256").update(email).digest("hex");
    const prefix = `free-call-limit:${environment}:{${digest}}`;
    return Effect.tryPromise({
      try: () =>
        redis.eval(script, 2, `${prefix}:pending`, `${prefix}:dialed`, ...args),
      catch: unavailable,
    }).pipe(
      Effect.timeoutFail({ duration: "3 seconds", onTimeout: unavailable }),
    );
  };
  return {
    reserve: (email: string, requestId: string) =>
      run(reserveSlot, email, requestId, RESERVATION_MS, WINDOW_MS, LIMIT).pipe(
        Effect.flatMap((allowed) =>
          allowed === 1
            ? Effect.void
            : Effect.fail(
                new FreeCallLimitError({ code: "daily_free_call_limit" }),
              ),
        ),
      ),
    complete: (email: string, requestId: string) =>
      run(completeSlot, email, requestId, WINDOW_MS).pipe(
        Effect.flatMap((saved) =>
          saved === 1 ? Effect.void : Effect.fail(unavailable()),
        ),
      ),
    release: (email: string, requestId: string) =>
      run(releaseSlot, email, requestId).pipe(Effect.asVoid),
  };
};

export class CallLimit extends Effect.Service<CallLimit>()("api/CallLimit", {
  effect: Effect.gen(function* () {
    const redis = yield* RedisClient;
    const mongo = yield* MongoClient;
    const environment = yield* environmentConfig;
    return makeCallLimit(redis, mongo.requests, environment);
  }),
}) {}
