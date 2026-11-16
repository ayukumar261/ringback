import { createHash, randomUUID } from "node:crypto";
import { Effect } from "effect";
import { Redis } from "ioredis";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { PreflightError, FreeCallLimitError } from "./errors.js";
import { makeCallLimit, makeFreeCallLimit } from "./limit.js";
import type { Environment } from "../environment.js";

const redisUrl = process.env.REDIS_URL;
const DAY = 86_400_000;
const run = Effect.runPromise;
type QuotaError = PreflightError | FreeCallLimitError;
type Quota = {
  check: (
    identity: string,
    requestId?: string,
  ) => Effect.Effect<void, QuotaError>;
  reserve: (
    identity: string,
    requestId: string,
  ) => Effect.Effect<void, QuotaError>;
  complete: (
    identity: string,
    requestId: string,
  ) => Effect.Effect<void, QuotaError>;
  release: (
    identity: string,
    requestId: string,
  ) => Effect.Effect<void, QuotaError>;
};
const quotas: {
  name: string;
  make: (redis: Pick<Redis, "eval">, environment: Environment) => Quota;
  identity: string;
  other: string;
  key: (identity: string, environment: string) => string;
  limited: string;
  unavailable: string;
}[] = [
  {
    name: "destination",
    make: makeCallLimit,
    identity: "+14155552671",
    other: "+14155552672",
    key: (identity: string, env: string) => `call-limit:${env}:{${identity}}`,
    limited: "daily_call_limit",
    unavailable: "call_limit_unavailable",
  },
  {
    name: "free-call",
    make: makeFreeCallLimit,
    identity: "payer@example.com",
    other: "other@example.com",
    key: (identity: string, env: string) =>
      `free-call-limit:${env}:{${createHash("sha256").update(identity).digest("hex")}}`,
    limited: "daily_free_call_limit",
    unavailable: "free_call_limit_unavailable",
  },
];

for (const quota of quotas) {
  describe(`${quota.name} quota failures`, () => {
    it("fails closed when Redis rejects a command", async () => {
      const limit = quota.make(
        {
          eval: vi.fn(async () => {
            throw new Error("Redis unavailable");
          }),
        },
        "production",
      );
      for (const effect of [
        limit.check(quota.identity),
        limit.reserve(quota.identity, "request"),
        limit.complete(quota.identity, "request"),
        limit.release(quota.identity, "request"),
      ])
        expect(await run(Effect.flip(effect))).toMatchObject({
          code: quota.unavailable,
        });
    });
    it("bounds a Redis command that never responds", async () => {
      vi.useFakeTimers();
      try {
        const limit = quota.make(
          { eval: vi.fn(() => new Promise(() => {})) },
          "production",
        );
        const pending = run(
          Effect.flip(limit.reserve(quota.identity, "request")),
        );
        await vi.advanceTimersByTimeAsync(3100);
        expect(await pending).toMatchObject({ code: quota.unavailable });
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // Intentionally require only Redis: no Mongo client or URI is involved.
  describe.skipIf(!redisUrl)(`Redis ${quota.name} quota`, () => {
    const prefix = `test:${randomUUID()}:`;
    const redis = new Redis(redisUrl ?? "redis://127.0.0.1:6379", {
      keyPrefix: prefix,
      lazyConnect: true,
      maxRetriesPerRequest: 1,
    });
    const limit = quota.make(redis, "production");
    const keys = (identity = quota.identity, env = "production") => {
      const base = quota.key(identity, env);
      return { pending: `${base}:pending`, dialed: `${base}:dialed` };
    };
    const clear = async () => {
      const found = await redis.keys(`${prefix}*`);
      if (found.length)
        await redis.del(...found.map((key) => key.slice(prefix.length)));
    };
    const now = async () => {
      const [seconds, microseconds] = await redis.time();
      return Number(seconds) * 1000 + Math.floor(Number(microseconds) / 1000);
    };
    beforeAll(async () => {
      await redis.connect();
    });
    beforeEach(clear);
    afterAll(async () => {
      try {
        await clear();
      } finally {
        await redis.quit();
      }
    });

    it("checks before Checkout without consuming capacity", async () => {
      for (let index = 0; index < 5; index++)
        await run(limit.check(quota.identity));
      expect(await redis.keys(`${prefix}*`)).toEqual([]);
    });
    it("allows three calls, then refuses checks and reservations for a fourth", async () => {
      for (let index = 0; index < 3; index++) {
        await run(limit.check(quota.identity));
        await run(limit.reserve(quota.identity, `request-${index}`));
        await run(limit.complete(quota.identity, `request-${index}`));
      }
      for (const effect of [
        limit.check(quota.identity),
        limit.reserve(quota.identity, "fourth"),
      ])
        expect(await run(Effect.flip(effect))).toMatchObject({
          code: quota.limited,
        });
      expect(await redis.zcard(keys().dialed)).toBe(3);
    });
    it("atomically admits only three concurrent reservations", async () => {
      const results = await Promise.all(
        Array.from({ length: 20 }, (_, index) =>
          run(Effect.either(limit.reserve(quota.identity, `request-${index}`))),
        ),
      );
      expect(results.filter((result) => result._tag === "Right")).toHaveLength(
        3,
      );
      expect(results.filter((result) => result._tag === "Left")).toHaveLength(
        17,
      );
      expect(await redis.zcard(keys().pending)).toBe(3);
      expect(await run(Effect.flip(limit.check(quota.identity)))).toMatchObject(
        { code: quota.limited },
      );
    });
    it("is idempotent and excludes the current request from its check", async () => {
      await run(limit.reserve(quota.identity, "first"));
      const reservedAt = await redis.zscore(keys().pending, "first");
      await run(limit.reserve(quota.identity, "first"));
      expect(await redis.zscore(keys().pending, "first")).toBe(reservedAt);
      await run(limit.complete(quota.identity, "first"));
      const completedAt = await redis.zscore(keys().dialed, "first");
      await run(limit.reserve(quota.identity, "first"));
      await run(limit.complete(quota.identity, "first"));
      expect(await redis.zscore(keys().dialed, "first")).toBe(completedAt);
      await run(limit.reserve(quota.identity, "second"));
      await run(limit.reserve(quota.identity, "third"));
      await expect(
        run(limit.check(quota.identity, "first")),
      ).resolves.toBeUndefined();
      await expect(
        run(limit.check(quota.identity, "second")),
      ).resolves.toBeUndefined();
      expect(
        await run(Effect.flip(limit.check(quota.identity, "unknown"))),
      ).toMatchObject({ code: quota.limited });
    });
    it("expires the rolling 24-hour boundary while retaining recent calls", async () => {
      const timestamp = await now();
      await redis.zadd(
        keys().dialed,
        timestamp - DAY,
        "boundary",
        timestamp - DAY - 1,
        "older",
        timestamp - 60_000,
        "recent-1",
        timestamp - 120_000,
        "recent-2",
      );
      await redis.pexpire(keys().dialed, DAY);
      await run(limit.check(quota.identity));
      expect(await redis.zrange(keys().dialed, 0, -1)).toEqual([
        "recent-2",
        "recent-1",
      ]);
      await run(limit.reserve(quota.identity, "third"));
      expect(
        await run(Effect.flip(limit.reserve(quota.identity, "fourth"))),
      ).toMatchObject({ code: quota.limited });
    });
    it("expires pending keys after two minutes and completed keys after 24 hours", async () => {
      await run(limit.reserve(quota.identity, "request"));
      expect(await redis.pttl(keys().pending)).toBeGreaterThan(115_000);
      expect(await redis.pttl(keys().pending)).toBeLessThanOrEqual(120_000);
      await run(limit.complete(quota.identity, "request"));
      expect(await redis.exists(keys().pending)).toBe(0);
      expect(await redis.pttl(keys().dialed)).toBeGreaterThan(DAY - 5000);
      expect(await redis.pttl(keys().dialed)).toBeLessThanOrEqual(DAY);
      if (quota.name === "free-call")
        expect(
          (await redis.keys(`${prefix}*`)).every(
            (key) => !key.includes(quota.identity),
          ),
        ).toBe(true);
    });
    it("releases stale reservations using Redis time even if the API clock differs", async () => {
      const timestamp = await now();
      await redis.zadd(
        keys().pending,
        timestamp - 120_000,
        "stale-1",
        timestamp - 120_001,
        "stale-2",
        timestamp - 1000,
        "fresh",
      );
      vi.spyOn(Date, "now").mockReturnValue(timestamp + DAY);
      try {
        await run(limit.reserve(quota.identity, "next"));
        expect(await redis.zrange(keys().pending, 0, -1)).toEqual([
          "fresh",
          "next",
        ]);
      } finally {
        vi.restoreAllMocks();
      }
    });
    it("keeps identities and environments separate", async () => {
      const development = quota.make(redis, "development");
      for (let index = 0; index < 3; index++) {
        await run(limit.reserve(quota.identity, `prod-${index}`));
        await run(limit.reserve(quota.other, `other-${index}`));
        await run(development.reserve(quota.identity, `dev-${index}`));
      }
      for (const effect of [
        limit.check(quota.identity),
        limit.check(quota.other),
        development.check(quota.identity),
      ])
        expect(await run(Effect.flip(effect))).toMatchObject({
          code: quota.limited,
        });
      expect(await redis.zcard(keys(quota.other).pending)).toBe(3);
    });
    it("releases failed reservations idempotently without losing completed calls", async () => {
      await run(limit.reserve(quota.identity, "completed"));
      await run(limit.complete(quota.identity, "completed"));
      await run(limit.reserve(quota.identity, "failed"));
      await run(limit.release(quota.identity, "failed"));
      await run(limit.release(quota.identity, "failed"));
      expect(await redis.exists(keys().pending)).toBe(0);
      expect(await redis.zrange(keys().dialed, 0, -1)).toEqual(["completed"]);
    });
    it("requires a reservation before recording a completed call", async () => {
      expect(
        await run(Effect.flip(limit.complete(quota.identity, "unreserved"))),
      ).toMatchObject({ code: quota.unavailable });
      expect(await redis.keys(`${prefix}*`)).toEqual([]);
    });
    it("starts fresh when quota keys are cleared and ignores legacy snapshots", async () => {
      if (quota.name === "destination")
        await redis.set(
          `call-limit:production:${quota.identity}`,
          JSON.stringify({ revision: "old", entries: [1, 2, 3] }),
        );
      for (let index = 0; index < 3; index++) {
        await run(limit.reserve(quota.identity, `request-${index}`));
        await run(limit.complete(quota.identity, `request-${index}`));
      }
      expect(await run(Effect.flip(limit.check(quota.identity)))).toMatchObject(
        { code: quota.limited },
      );
      await redis.del(keys().pending, keys().dialed);
      await expect(run(limit.check(quota.identity))).resolves.toBeUndefined();
      await run(limit.reserve(quota.identity, "fresh"));
      expect(await redis.zrange(keys().pending, 0, -1)).toEqual(["fresh"]);
      expect(await redis.zcard(keys().dialed)).toBe(0);
    });
  });
}
