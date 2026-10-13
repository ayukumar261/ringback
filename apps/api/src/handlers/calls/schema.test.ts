import { describe, expect, it } from "vitest";
import { eventCursor } from "./schema.js";

describe("eventCursor", () => {
  it.each([undefined, "", "yesterday", "1", "1-", "-1-0", "1-0 trailing"])(
    "ignores malformed cursor %s",
    (cursor) => {
      expect(eventCursor(cursor)).toBeUndefined();
    },
  );
  it("accepts Redis millisecond-sequence cursors", () => {
    expect(eventCursor("1720000000000-12")).toBe("1720000000000-12");
  });
});
