import { createHash } from "node:crypto";
import { Effect } from "effect";
import type { Redis } from "ioredis";
import { RedisClient } from "../clients/redis.js";
import { environmentConfig, type Environment } from "../environment.js";
import { FreeCallLimitError, PreflightError } from "./errors.js";

const WINDOW_MS = 24 * 60 * 60_000;
const LIMIT = 3;
const RESERVATION_MS = 120_000;

// Server time keeps every dispatcher on the same rolling window. A reservation
// expires with a stale dispatch claim; completed calls count for 24 hours.
const checkSlot = `
local time = redis.call('TIME')
local now = time[1] * 1000 + math.floor(time[2] / 1000)
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now - tonumber(ARGV[2]))
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', now - tonumber(ARGV[3]))
local count = redis.call('ZCARD', KEYS[1]) + redis.call('ZCARD', KEYS[2])
if ARGV[1] ~= '' then
  if redis.call('ZSCORE', KEYS[1], ARGV[1]) then count = count - 1 end
  if redis.call('ZSCORE', KEYS[2], ARGV[1]) then count = count - 1 end
end
if count >= tonumber(ARGV[4]) then return 0 end
return 1
`;

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

const makeQuota = <E>(
  redis: Pick<Redis, "eval">,
  keyPrefix: (identity: string) => string,
  unavailable: () => E,
  limited: () => E,
) => {
  const run = (
    script: string,
    identity: string,
    ...args: (string | number)[]
  ) => {
    const prefix = keyPrefix(identity);
    return Effect.tryPromise({
      try: () =>
        redis.eval(script, 2, `${prefix}:pending`, `${prefix}:dialed`, ...args),
      catch: unavailable,
    }).pipe(
      Effect.timeoutFail({ duration: "3 seconds", onTimeout: unavailable }),
    );
  };
  return {
    check: (identity: string, requestId = "") =>
      run(
        checkSlot,
        identity,
        requestId,
        RESERVATION_MS,
        WINDOW_MS,
        LIMIT,
      ).pipe(
        Effect.flatMap((allowed) =>
          allowed === 1 ? Effect.void : Effect.fail(limited()),
        ),
      ),
    reserve: (identity: string, requestId: string) =>
      run(
        reserveSlot,
        identity,
        requestId,
        RESERVATION_MS,
        WINDOW_MS,
        LIMIT,
      ).pipe(
        Effect.flatMap((allowed) =>
          allowed === 1 ? Effect.void : Effect.fail(limited()),
        ),
      ),
    complete: (identity: string, requestId: string) =>
      run(completeSlot, identity, requestId, WINDOW_MS).pipe(
        Effect.flatMap((saved) =>
          saved === 1 ? Effect.void : Effect.fail(unavailable()),
        ),
      ),
    release: (identity: string, requestId: string) =>
      run(releaseSlot, identity, requestId).pipe(Effect.asVoid),
  };
};

// Redis is the source of truth for both quotas. No historical requests are
// imported after a reset; request IDs keep every operation idempotent.
export const makeCallLimit = (
  redis: Pick<Redis, "eval">,
  environment: Environment,
) =>
  makeQuota(
    redis,
    (number) => `call-limit:${environment}:{${number}}`,
    () => new PreflightError({ code: "call_limit_unavailable" }),
    () => new PreflightError({ code: "daily_call_limit" }),
  );

// Only the hash of the normalized email appears in Redis keys.
export const makeFreeCallLimit = (
  redis: Pick<Redis, "eval">,
  environment: Environment,
) =>
  makeQuota(
    redis,
    (email) => {
      const digest = createHash("sha256").update(email).digest("hex");
      return `free-call-limit:${environment}:{${digest}}`;
    },
    () => new FreeCallLimitError({ code: "free_call_limit_unavailable" }),
    () => new FreeCallLimitError({ code: "daily_free_call_limit" }),
  );

export class CallLimit extends Effect.Service<CallLimit>()("api/CallLimit", {
  effect: Effect.gen(function* () {
    const redis = yield* RedisClient;
    const environment = yield* environmentConfig;
    return makeCallLimit(redis, environment);
  }),
}) {}
