import { ConfigProvider, Effect, Redacted } from "effect";
import type { Redis } from "ioredis";
import { describe, expect, it, vi } from "vitest";
import { makeTwilioClient, twilioConfig } from "./twilio.js";

const number = "+14155552671";
const response = (changes: Record<string, unknown> = {}) => ({
  phone_number: number,
  country_code: "US",
  valid: true,
  line_type_intelligence: {
    type: "mobile",
    error_code: null,
    carrier_name: "Current carrier",
  },
  ...changes,
});

const harness = () => {
  let time = 1_000_000;
  const entries = new Map<string, string>();
  const get = vi.fn(async (key: string) => entries.get(key) ?? null);
  const set = vi.fn(async (key: string, value: string) => {
    entries.set(key, value);
    return "OK";
  });
  const fetch = vi.fn<typeof globalThis.fetch>(async () =>
    Response.json(response()),
  );
  const options = {
    accountSid: Redacted.make("AC_test"),
    authToken: Redacted.make("private_token"),
    timeoutMs: 50,
    cacheTtlSeconds: 60,
    cache: { get, set } as unknown as Pick<Redis, "get" | "set">,
    fetch,
    now: () => time,
  };
  return {
    entries,
    get,
    set,
    fetch,
    options,
    client: makeTwilioClient(options),
    advance: (ms: number) => {
      time += ms;
    },
  };
};

describe("Twilio Lookup", () => {
  it("authenticates with Account SID/Auth Token and requests current line-type data", async () => {
    const h = harness();
    const result = await Effect.runPromise(h.client.lookup(number));
    const [url, init] = h.fetch.mock.calls[0]!;
    expect(String(url)).toBe(
      "https://lookups.twilio.com/v2/PhoneNumbers/%2B14155552671?Fields=line_type_intelligence",
    );
    expect(init).toMatchObject({
      headers: {
        Authorization: `Basic ${Buffer.from("AC_test:private_token").toString("base64")}`,
      },
      redirect: "error",
    });
    expect(result).toMatchObject({
      number,
      valid: true,
      country: "US",
      lineType: "mobile",
      checkedAt: 1_000_000,
      expiresAt: 1_060_000,
    });
    expect(JSON.stringify(result)).not.toContain("private_token");
  });

  it("uses explicit expiry as well as Redis TTL, refreshing ported numbers after expiry", async () => {
    const h = harness();
    await Effect.runPromise(h.client.lookup(number));
    h.fetch.mockResolvedValueOnce(
      Response.json(
        response({
          line_type_intelligence: { type: "nonFixedVoip", error_code: null },
        }),
      ),
    );
    h.advance(59_999);
    expect((await Effect.runPromise(h.client.lookup(number))).lineType).toBe(
      "mobile",
    );
    expect(h.fetch).toHaveBeenCalledTimes(1);
    h.advance(1);
    expect((await Effect.runPromise(h.client.lookup(number))).lineType).toBe(
      "nonFixedVoip",
    );
    expect(h.fetch).toHaveBeenCalledTimes(2);
    expect(h.set).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      "EX",
      60,
    );
    expect([...h.entries.keys()][0]).not.toContain(number);
  });

  it.each([
    { valid: false, line_type_intelligence: null },
    { line_type_intelligence: null },
    { line_type_intelligence: { type: "newProviderType", error_code: null } },
    { line_type_intelligence: { type: null, error_code: 60601 } },
  ])(
    "does not cache invalid, unknown, or inaccessible results: %j",
    async (changes) => {
      const h = harness();
      h.fetch.mockImplementation(async () => Response.json(response(changes)));
      const result = await Effect.runPromise(h.client.lookup(number));
      expect(result.lineType).toBe("unknown");
      expect(result.lineTypeError).toBe(
        changes.line_type_intelligence?.error_code ?? null,
      );
      await Effect.runPromise(h.client.lookup(number));
      expect(h.fetch).toHaveBeenCalledTimes(2);
      expect(h.set).not.toHaveBeenCalled();
    },
  );

  it.each([401, 403, 429, 500])(
    "sanitizes HTTP %s failures",
    async (status) => {
      const h = harness();
      h.fetch.mockResolvedValueOnce(
        new Response("private provider error", { status }),
      );
      const error = await Effect.runPromise(
        h.client.lookup(number).pipe(Effect.flip),
      );
      expect(error.code).toBe(
        [401, 403].includes(status)
          ? "lookup_access_denied"
          : "lookup_unavailable",
      );
      expect(JSON.stringify(error)).not.toMatch(/private|AC_test/);
      expect(h.set).not.toHaveBeenCalled();
    },
  );

  it.each([{}, { valid: "true" }, response({ phone_number: "+14165552671" })])(
    "rejects malformed or mismatched responses",
    async (body) => {
      const h = harness();
      h.fetch.mockResolvedValueOnce(Response.json(body));
      expect(
        (await Effect.runPromise(h.client.lookup(number).pipe(Effect.flip)))
          .code,
      ).toBe("lookup_unavailable");
    },
  );

  it("aborts slow lookups without exposing credentials", async () => {
    const h = harness();
    h.fetch.mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init!.signal!.addEventListener(
            "abort",
            () => reject(new Error("private_token")),
            { once: true },
          );
        }),
    );
    const error = await Effect.runPromise(
      h.client.lookup(number).pipe(Effect.flip),
    );
    expect(error.code).toBe("lookup_unavailable");
    expect(JSON.stringify(error)).not.toContain("private_token");
  });

  it("refreshes corrupt cache entries and tolerates cache outages", async () => {
    const h = harness();
    h.get.mockResolvedValueOnce("not JSON");
    await Effect.runPromise(h.client.lookup(number));
    h.get.mockRejectedValueOnce(new Error("cache down"));
    h.set.mockRejectedValueOnce(new Error("cache down"));
    expect((await Effect.runPromise(h.client.lookup(number))).valid).toBe(true);
    expect(h.fetch).toHaveBeenCalledTimes(2);
  });

  it("bounds cache operations even when Redis keeps reconnecting", async () => {
    const h = harness();
    h.get.mockImplementationOnce(() => new Promise(() => {}));
    h.set.mockImplementationOnce(() => new Promise(() => {}));
    expect((await Effect.runPromise(h.client.lookup(number))).valid).toBe(true);
    expect(h.fetch).toHaveBeenCalledTimes(1);
  });

  it("allows startup without credentials but refuses Lookup", async () => {
    const h = harness();
    const client = makeTwilioClient({
      ...h.options,
      authToken: Redacted.make(""),
    });
    expect(
      (await Effect.runPromise(client.lookup(number).pipe(Effect.flip))).code,
    ).toBe("lookup_unavailable");
    expect(h.fetch).not.toHaveBeenCalled();
  });
});

it("loads redacted credentials and bounded cache/timeout configuration", async () => {
  const load = (values: [string, string][]) =>
    Effect.runPromise(
      Effect.gen(function* () {
        return yield* twilioConfig;
      }).pipe(
        Effect.withConfigProvider(ConfigProvider.fromMap(new Map(values))),
      ),
    );
  const config = await load([
    ["TWILIO_ACCOUNT_SID", "AC_private"],
    ["TWILIO_AUTH_TOKEN", "secret"],
  ]);
  expect(config.timeoutMs).toBe(5_000);
  expect(config.cacheTtlSeconds).toBe(3_600);
  expect(JSON.stringify(config)).not.toMatch(/AC_private|secret/);
  for (const setting of [
    "RINGBACK_LOOKUP_TIMEOUT_MS",
    "RINGBACK_LOOKUP_CACHE_TTL_SECONDS",
  ]) {
    await expect(load([[setting, "0"]])).rejects.toThrow();
    await expect(load([[setting, "999999999"]])).rejects.toThrow();
  }
});
