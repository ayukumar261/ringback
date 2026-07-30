import { Config, Effect } from "effect";
import { Redis } from "ioredis";

// RedisClient is the api's shared ioredis connection.
export class RedisClient extends Effect.Service<RedisClient>()(
  "api/RedisClient",
  {
    scoped: Effect.gen(function* () {
      const url = yield* Config.string("REDIS_URL").pipe(
        Config.withDefault("redis://127.0.0.1:6379"),
      );
      return yield* Effect.acquireRelease(
        Effect.sync(() => new Redis(url, { maxRetriesPerRequest: null })),
        (redis) => Effect.sync(() => redis.disconnect()),
      );
    }),
  },
) {}
