import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import { TwilioError, type PhoneLookup } from "../clients/twilio.js";
import { makePreflight } from "./preflight.js";
import { PreflightError } from "./errors.js";

const harness = (result: Partial<PhoneLookup> = {}) => {
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
    client: makePreflight(lookup),
  };
};

describe("phone preflight", () => {
  it.each(["landline", "mobile", "fixedVoip", "nonFixedVoip"] as const)(
    "approves US %s numbers using both numbering region and Lookup",
    async (lineType) => {
      const h = harness({ lineType });
      expect(
        await Effect.runPromise(h.client.check("+14155552671")),
      ).toMatchObject({ country: "US", lineType });
      expect(h.lookup).toHaveBeenCalledWith("+14155552671", expect.anything());
    },
  );

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
  ])("rejects %s before paid provider work", async (number, code) => {
    const h = harness();
    const error = await Effect.runPromise(
      h.client.check(number).pipe(Effect.flip),
    );
    expect(error.code).toBe(code);
    expect(h.lookup).not.toHaveBeenCalled();
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

  describe.each(["800", "833", "844", "855", "866", "877", "888"])(
    "%s toll-free numbers",
    (prefix) => {
      const number = `+1${prefix}5552671`;

      it.each(["US", "CA", null])(
        "approves toll-free calls with Lookup country %s",
        async (country) => {
          const h = harness({ country, lineType: "tollFree" });
          expect(
            (await Effect.runPromise(h.client.check(number))).lineType,
          ).toBe("tollFree");
          expect(h.lookup).toHaveBeenCalledWith(number, expect.anything());
        },
      );
    },
  );

  it.each([
    [{ valid: false }, "invalid_destination"],
    [{ number: "+18885552671" }, "invalid_destination"],
    [{ lineType: "unknown" }, "line_type_unavailable"],
    [{ lineTypeError: 60601 }, "line_type_unavailable"],
    [{ lineType: "premium" }, "blocked_number"],
    [{ lineType: "sharedCost" }, "blocked_number"],
    [{ lineType: "mobile" }, "unsupported_line_type"],
  ] as [Partial<PhoneLookup>, string][])(
    "requires valid, confirmed toll-free Lookup data: %j",
    async (result, code) => {
      const h = harness({ country: null, lineType: "tollFree", ...result });
      expect(
        (
          await Effect.runPromise(
            h.client.check("+18005552671").pipe(Effect.flip),
          )
        ).code,
      ).toBe(code);
    },
  );

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

  it("turns provider failures into typed preflight failures", async () => {
    const check = makePreflight(() =>
      Effect.fail(new TwilioError({ code: "lookup_access_denied" })),
    ).check;
    expect(
      await Effect.runPromise(check("+14155552671").pipe(Effect.flip)),
    ).toBeInstanceOf(PreflightError);
  });
});
