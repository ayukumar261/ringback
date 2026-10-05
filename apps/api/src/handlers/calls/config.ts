import { Config, Effect } from "effect";

// positiveInteger reads a setting small enough for Mongo limits and Node timers.
const positiveInteger = (key: string, fallback: number) =>
  Config.integer(key).pipe(
    Config.withDefault(fallback),
    Config.validate({
      message: `${key} must be an integer between 1 and 2147483647`,
      validation: (value) =>
        Number.isInteger(value) && value > 0 && value <= 2_147_483_647,
    }),
  );

// callsConfig is the snapshot limit and SSE timing for the calls routes.
export const callsConfig = Config.all({
  snapshotLimit: positiveInteger("RINGBACK_CALLS_SNAPSHOT_LIMIT", 100),
  keepaliveMs: positiveInteger("RINGBACK_CALLS_KEEPALIVE_MS", 15_000),
  retryMs: positiveInteger("RINGBACK_CALLS_RETRY_MS", 3_000),
});

// CallsConfig is the validated calls settings.
export class CallsConfig extends Effect.Service<CallsConfig>()(
  "api/CallsConfig",
  { effect: callsConfig },
) {}
