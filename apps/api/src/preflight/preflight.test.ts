import { ConfigProvider, Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import { TwilioError, type PhoneLookup } from "../clients/twilio.js";
import { preflightConfig, PreflightConfig } from "./config.js";
import { makePreflight } from "./preflight.js";
import { PreflightError } from "./errors.js";

const settings: Omit<PreflightConfig, "_tag"> = {
  countries: ["US"],
  territories: [],
  lineTypes: ["landline", "mobile", "fixedVoip", "nonFixedVoip"],
  allowTollFree: false,
  blockedPrefixes: [],
};
const harness = (
  result: Partial<PhoneLookup> = {},
  overrides: Partial<typeof settings> = {},
) => {
  const lookup = vi.fn((number: string) =>
    Effect.succeed({
      number,
      valid: true,
      country: "US",
      lineType: "mobile",
      lineTypeError: null,
      checkedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      ...result,
    } satisfies PhoneLookup),
  );
  return {
    lookup,
    client: makePreflight(lookup, { ...settings, ...overrides }),
  };
};

describe("phone preflight", () => {
  it("approves US numbers using both numbering region and Lookup", async () => {
    const h = harness();
    expect(
      (await Effect.runPromise(h.client.check("+14155552671"))).country,
    ).toBe("US");
    expect(h.lookup).toHaveBeenCalledWith("+14155552671", expect.anything());
  });

  it("records a billed Lookup against the call request it checked", async () => {
    const record = vi.fn(() => Effect.void);
    const check = makePreflight(
      (number, onBilled = Effect.void) =>
        onBilled.pipe(
          Effect.as({
            number,
            valid: true,
            country: "US",
            lineType: "mobile" as const,
            lineTypeError: null,
            checkedAt: Date.now(),
            expiresAt: Date.now() + 60_000,
          }),
        ),
      settings,
      record,
    ).check;
    await Effect.runPromise(
      check("+14155552671", { requestId: "request-test", room: "call_test" }),
    );
    expect(record).toHaveBeenCalledExactlyOnceWith({
      requestId: "request-test",
      room: "call_test",
    });
  });

  it.each([
    ["911", "invalid_destination"],
    ["411", "invalid_destination"],
    ["+19115552671", "blocked_number"],
    ["+14159112671", "blocked_number"],
    ["+19005552671", "blocked_number"],
    ["+14159762671", "blocked_number"],
    ["+14163922489", "unsupported_country"],
    ["+16045552671", "unsupported_country"],
    ["+12423227000", "unsupported_country"],
    ["+18765552671", "unsupported_country"],
    ["+17875552671", "unsupported_country"],
    ["+13405552671", "unsupported_country"],
    ["+442079460123", "unsupported_country"],
    ["+15551234567", "invalid_destination"],
    ["+18005552671", "toll_free_not_allowed"],
    ["+18885552671", "toll_free_not_allowed"],
  ])("rejects %s before paid provider work", async (number, code) => {
    const h = harness();
    const error = await Effect.runPromise(
      h.client.check(number).pipe(Effect.flip),
    );
    expect(error.code).toBe(code);
    expect(h.lookup).not.toHaveBeenCalled();
  });

  it("only enables US territories explicitly", async () => {
    const h = harness({ country: "PR" }, { territories: ["PR"] });
    expect(
      (await Effect.runPromise(h.client.check("+17875552671"))).country,
    ).toBe("PR");
  });

  it.each([
    { country: "CA", lineType: "mobile", lineTypeError: null },
    { country: "CA", lineType: "unknown", lineTypeError: 60601 },
  ] as Partial<PhoneLookup>[])(
    "rejects Canada before Lookup regardless of line-type access: %j",
    async (result) => {
      const h = harness(result);
      expect(
        (
          await Effect.runPromise(
            h.client.check("+14165552671").pipe(Effect.flip),
          )
        ).code,
      ).toBe("unsupported_country");
      expect(h.lookup).not.toHaveBeenCalled();
    },
  );

  it("handles shared NANP toll-free independently of country attribution", async () => {
    const h = harness(
      { country: null, lineType: "tollFree" },
      { allowTollFree: true },
    );
    expect(
      (await Effect.runPromise(h.client.check("+18005552671"))).lineType,
    ).toBe("tollFree");
    const mismatch = harness({ lineType: "mobile" }, { allowTollFree: true });
    expect(
      (
        await Effect.runPromise(
          mismatch.client.check("+18005552671").pipe(Effect.flip),
        )
      ).code,
    ).toBe("unsupported_line_type");
  });

  it.each([
    [{ valid: false }, "invalid_destination"],
    [{ country: "CA" }, "unsupported_country"],
    [{ country: null }, "unsupported_country"],
    [{ lineType: "unknown" }, "line_type_unavailable"],
    [{ lineTypeError: 60601 }, "line_type_unavailable"],
    [{ lineType: "premium" }, "blocked_number"],
    [{ lineType: "sharedCost" }, "blocked_number"],
    ...["personal", "uan", "voicemail", "pager", "tollFree"].map((lineType) => [
      { lineType },
      "unsupported_line_type",
    ]),
  ] as [Partial<PhoneLookup>, string][])(
    "refuses invalid, inaccessible, or unsupported Lookup data: %j",
    async (result, code) => {
      const h = harness(result);
      expect(
        (
          await Effect.runPromise(
            h.client.check("+14155552671").pipe(Effect.flip),
          )
        ).code,
      ).toBe(code);
    },
  );

  it("uses current carrier line type for ported numbers instead of guessing from the prefix", async () => {
    const h = harness({ lineType: "nonFixedVoip" });
    expect(
      (await Effect.runPromise(h.client.check("+14155552671"))).lineType,
    ).toBe("nonFixedVoip");
    const restricted = harness(
      { lineType: "nonFixedVoip" },
      { lineTypes: ["mobile"] },
    );
    expect(
      (
        await Effect.runPromise(
          restricted.client.check("+14155552671").pipe(Effect.flip),
        )
      ).code,
    ).toBe("unsupported_line_type");
  });

  it("blocks configured high-risk prefixes before Lookup", async () => {
    const h = harness({}, { blockedPrefixes: ["+1415"] });
    expect(
      (
        await Effect.runPromise(
          h.client.check("+14155552671").pipe(Effect.flip),
        )
      ).code,
    ).toBe("blocked_number");
    expect(h.lookup).not.toHaveBeenCalled();
  });

  it("turns provider failures into typed preflight failures", async () => {
    const check = makePreflight(
      () => Effect.fail(new TwilioError({ code: "lookup_access_denied" })),
      settings,
    ).check;
    expect(
      await Effect.runPromise(check("+14155552671").pipe(Effect.flip)),
    ).toBeInstanceOf(PreflightError);
  });
});

describe("preflight settings", () => {
  const load = (values: [string, string][] = []) =>
    Effect.runPromise(
      Effect.gen(function* () {
        return yield* preflightConfig;
      }).pipe(
        Effect.withConfigProvider(ConfigProvider.fromMap(new Map(values))),
      ),
    );
  it("defaults to US-only with territories and toll-free disabled", async () => {
    expect(await load()).toEqual(settings);
  });
  it.each([
    ["RINGBACK_ALLOWED_COUNTRIES", ""],
    ["RINGBACK_ALLOWED_COUNTRIES", "CA"],
    ["RINGBACK_ALLOWED_COUNTRIES", "US,CA"],
    ["RINGBACK_ALLOWED_COUNTRIES", "US,JM"],
    ["RINGBACK_ALLOWED_US_TERRITORIES", "CA"],
    ["RINGBACK_ALLOWED_LINE_TYPES", "premium"],
    ["RINGBACK_ALLOW_NANP_TOLL_FREE", "maybe"],
    ["RINGBACK_BLOCKED_PHONE_PREFIXES", "415"],
  ])("rejects invalid policy %s=%s", async (key, value) => {
    await expect(load([[key, value]])).rejects.toThrow();
  });
});
