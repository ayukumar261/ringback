import { describe, expect, it } from "vitest";
import { toEntries } from "./materializer.js";

describe("toEntries", () => {
  it("returns no entries for a null reply", () => {
    expect(toEntries(null)).toEqual([]);
  });

  it("flattens the reply's entries, keeping order", () => {
    const reply = [
      [
        "ringback:calls",
        [
          ["1-1", ["event", "call.started", "room", "a"]],
          ["2-1", ["event", "call.ended", "room", "a"]],
        ],
      ],
    ];
    expect(toEntries(reply)).toEqual([
      { id: "1-1", fields: ["event", "call.started", "room", "a"] },
      { id: "2-1", fields: ["event", "call.ended", "room", "a"] },
    ]);
  });

  it("keeps entries trimmed away while pending, with null fields", () => {
    const reply = [["ringback:calls", [["1-1", null]]]];
    expect(toEntries(reply)).toEqual([{ id: "1-1", fields: null }]);
  });
});
