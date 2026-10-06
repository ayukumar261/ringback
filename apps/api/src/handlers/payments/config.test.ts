import { ConfigProvider, Effect } from "effect";
import { describe, expect, it } from "vitest";
import { paymentConfig, PaymentConfig } from "./config.js";

const load = (values: Record<string, string | undefined> = {}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      return yield* paymentConfig;
    }).pipe(
      Effect.withConfigProvider(
        ConfigProvider.fromMap(
          new Map(
            Object.entries(values).filter(
              (entry): entry is [string, string] => entry[1] !== undefined,
            ),
          ),
        ),
      ),
    ),
  );

describe("payment configuration", () => {
  it("defaults to development with a fixed quote", async () => {
    expect(await load()).toMatchObject({
      environment: "development",
      amount: 50,
      currency: "usd",
      requireTerms: false,
      publicWebUrl: "http://localhost:3000",
    });
  });
  it("normalizes the website URL independently of the API URL", async () => {
    const config = await load({
      RINGBACK_PUBLIC_API_URL: "https://example.com/api/",
      RINGBACK_PUBLIC_WEB_URL: "https://example.com///",
    });
    expect(config.publicApiUrl).toBe("https://example.com/api");
    expect(config.publicWebUrl).toBe("https://example.com");
  });
  it("normalizes a public API URL including its path", async () => {
    expect(
      (await load({ RINGBACK_PUBLIC_API_URL: "https://example.com/api///" }))
        .publicApiUrl,
    ).toBe("https://example.com/api");
  });
  it.each([
    { RINGBACK_CALL_PRICE_CENTS: "0" },
    { RINGBACK_CALL_PRICE_CENTS: "9007199254740992" },
    { RINGBACK_CALL_CURRENCY: "USD" },
    { NODE_ENV: "wrong" },
    { RINGBACK_PUBLIC_API_URL: "javascript:alert(1)" },
    { RINGBACK_PUBLIC_API_URL: "https://user:pass@example.com" },
    { RINGBACK_PUBLIC_API_URL: "https://example.com?x=1" },
    { RINGBACK_PUBLIC_API_URL: "https://example.com#x" },
    { RINGBACK_PUBLIC_WEB_URL: "javascript:alert(1)" },
    { RINGBACK_PUBLIC_WEB_URL: "https://user:pass@example.com" },
    { RINGBACK_PUBLIC_WEB_URL: "https://example.com?x=1" },
    { RINGBACK_PUBLIC_WEB_URL: "https://example.com#x" },
  ])("rejects invalid settings %j", async (values) => {
    await expect(load(values)).rejects.toThrow();
  });
  it("provides the configured service", async () => {
    const result = await Effect.runPromise(
      PaymentConfig.pipe(
        Effect.provide(PaymentConfig.Default),
        Effect.withConfigProvider(
          ConfigProvider.fromMap(new Map([["NODE_ENV", "production"]])),
        ),
      ),
    );
    expect(result.environment).toBe("production");
  });
});
