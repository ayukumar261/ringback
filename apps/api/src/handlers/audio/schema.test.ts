import { describe, expect, it } from "vitest";
import { parseRange } from "./schema.js";

describe("parseRange", () => {
  it("serves the whole file without a header or with one it cannot read", () => {
    const headers = [
      undefined,
      "",
      "bytes=",
      "bytes=-",
      "items=0-9",
      "bytes=9-3",
    ];
    for (const header of headers) {
      expect(parseRange(header, 100)).toEqual({ _tag: "full" });
    }
  });

  it("reads a bounded range and clamps its end to the last byte", () => {
    expect(parseRange("bytes=10-19", 100)).toEqual({
      _tag: "partial",
      start: 10,
      end: 19,
    });
    expect(parseRange("bytes=90-500", 100)).toEqual({
      _tag: "partial",
      start: 90,
      end: 99,
    });
  });

  it("runs an open-ended range to the last byte", () => {
    expect(parseRange("bytes=40-", 100)).toEqual({
      _tag: "partial",
      start: 40,
      end: 99,
    });
  });

  it("takes a suffix range as the last n bytes", () => {
    expect(parseRange("bytes=-10", 100)).toEqual({
      _tag: "partial",
      start: 90,
      end: 99,
    });
    expect(parseRange("bytes=-500", 100)).toEqual({
      _tag: "partial",
      start: 0,
      end: 99,
    });
  });

  it("refuses a range that starts past the end", () => {
    expect(parseRange("bytes=100-", 100)).toEqual({ _tag: "unsatisfiable" });
    expect(parseRange("bytes=250-300", 100)).toEqual({ _tag: "unsatisfiable" });
    expect(parseRange("bytes=-0", 100)).toEqual({ _tag: "unsatisfiable" });
  });
});
