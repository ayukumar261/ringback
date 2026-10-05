import { ConfigProvider, Effect } from "effect";
import { describe, expect, it } from "vitest";
import { callsConfig, CallsConfig } from "./config.js";

const provider = (values: Record<string, string> = {}) =>
  ConfigProvider.fromMap(new Map(Object.entries(values)));

const load = (values: Record<string, string> = {}) =>
  Effect.runPromise(
    callsConfig.pipe(Effect.withConfigProvider(provider(values))),
  );

describe("calls configuration", () => {
  it("preserves the existing snapshot and streaming defaults", async () => {
    expect(await load()).toEqual({
      snapshotLimit: 100,
      keepaliveMs: 15000,
      retryMs: 3000,
    });
  });

  it("accepts deployment overrides through the service", async () => {
    const settings = await Effect.runPromise(
      CallsConfig.pipe(
        Effect.provide(CallsConfig.Default),
        Effect.withConfigProvider(
          provider({
            RINGBACK_CALLS_SNAPSHOT_LIMIT: "25",
            RINGBACK_CALLS_KEEPALIVE_MS: "5000",
            RINGBACK_CALLS_RETRY_MS: "1000",
          }),
        ),
      ),
    );
    expect(settings).toMatchObject({
      snapshotLimit: 25,
      keepaliveMs: 5000,
      retryMs: 1000,
    });
  });

  describe.each([
    "RINGBACK_CALLS_SNAPSHOT_LIMIT",
    "RINGBACK_CALLS_KEEPALIVE_MS",
    "RINGBACK_CALLS_RETRY_MS",
  ])("%s", (key) => {
    it.each([
      "0",
      "-1",
      "1.5",
      "",
      " ",
      "nope",
      "Infinity",
      "2147483648",
      "9007199254740992",
    ])("rejects invalid value %j", async (value) => {
      await expect(load({ [key]: value })).rejects.toThrow(key);
    });
    it.each(["1", "2147483647"])("accepts the boundary %s", async (value) => {
      await expect(load({ [key]: value })).resolves.toBeDefined();
    });
  });
});
