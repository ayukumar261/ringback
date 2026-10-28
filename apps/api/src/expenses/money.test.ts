import { describe, expect, it } from "vitest";
import { decimal, dollarsToCents, negate } from "./money.js";

describe("money", () => {
  it("converts dollars to cents without rounding", () => {
    expect(dollarsToCents("0.008")).toBe("0.8");
    expect(dollarsToCents("0.0951234")).toBe("9.51234");
    expect(dollarsToCents("12")).toBe("1200");
    expect(dollarsToCents(String(1e-7))).toBe("0.00001");
  });

  it("flips Twilio's negative charges into positive cents", () => {
    expect(dollarsToCents(negate("-0.0085"))).toBe("0.85");
    expect(negate("0")).toBe("0");
  });

  it("stores exact decimal text as Decimal128", () => {
    expect(decimal("0.00001").toString()).toBe("0.00001");
  });

  it.each(["NaN", "Infinity", "", "1,5", "$1"])("rejects %j", (value) => {
    expect(() => dollarsToCents(value)).toThrow("invalid_decimal");
    expect(() => decimal(value)).toThrow("invalid_decimal");
  });
});
