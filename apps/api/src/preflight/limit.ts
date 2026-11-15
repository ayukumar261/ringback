import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import type { Redis } from "ioredis";
import type { Collection } from "mongodb";
import { MongoClient, type RequestDoc } from "../clients/mongo.js";
import { RedisClient } from "../clients/redis.js";
import { environmentConfig, type Environment } from "../environment.js";
import { PreflightError } from "./errors.js";

const WINDOW_MS = 24 * 60 * 60_000;
const LIMIT = 3;

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

export class CallLimit extends Effect.Service<CallLimit>()("api/CallLimit", {
  effect: Effect.gen(function* () {
    const redis = yield* RedisClient;
    const mongo = yield* MongoClient;
    const environment = yield* environmentConfig;
    return makeCallLimit(redis, mongo.requests, environment);
  }),
}) {}
