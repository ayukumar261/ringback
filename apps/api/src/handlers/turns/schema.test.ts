import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import type { TurnDoc } from "../../clients/mongo.js";
import { TurnSnapshot, encodeTurnSnapshots } from "./schema.js";

const turnDocs: TurnDoc[] = [
  {
    room: "r-a",
    seq: 1,
    role: "agent",
    text: "Hello, how can I help?",
    at: new Date(1000),
  },
  {
    room: "r-a",
    seq: 2,
    role: "user",
    text: "What are your hours?",
    at: new Date(4000),
  },
];

describe("TurnSnapshot", () => {
  it.each(["agent", "tool"] as const)(
    "round-trips a %s span as unix milliseconds",
    async (role) => {
      const doc: TurnDoc = {
        room: "r-a",
        seq: 1,
        role,
        text: "Hello",
        at: new Date(900),
        startedAt: new Date(1000),
        endedAt: new Date(1400),
        durationMs: 400,
      };
      const docs: TurnDoc[] = [doc];
      const out = await Effect.runPromise(encodeTurnSnapshots(docs));
      expect(out).toStrictEqual([
        {
          room: "r-a",
          seq: 1,
          role,
          text: "Hello",
          at: 900,
          started_at: 1000,
          ended_at: 1400,
          duration_ms: 400,
        },
      ]);
      expect(Schema.decodeUnknownSync(TurnSnapshot)(out[0])).toStrictEqual(doc);
    },
  );

  it("omits unknown spans and unfinished end fields", async () => {
    const docs: TurnDoc[] = [
      { room: "r-a", seq: 1, role: "user", text: "Hi", at: new Date(0) },
      {
        room: "r-a",
        seq: 2,
        role: "agent",
        text: "Hello",
        at: new Date(1),
        startedAt: new Date(0),
      },
    ];
    expect(await Effect.runPromise(encodeTurnSnapshots(docs))).toStrictEqual([
      { room: "r-a", seq: 1, role: "user", text: "Hi", at: 0 },
      {
        room: "r-a",
        seq: 2,
        role: "agent",
        text: "Hello",
        at: 1,
        started_at: 0,
      },
    ]);
  });

  it("encodes docs into the SSE wire dialect", async () => {
    const docs: TurnDoc[] = turnDocs;
    const out = await Effect.runPromise(encodeTurnSnapshots(docs));
    expect(out).toEqual([
      {
        room: "r-a",
        seq: 1,
        role: "agent",
        text: "Hello, how can I help?",
        at: 1000,
      },
      {
        room: "r-a",
        seq: 2,
        role: "user",
        text: "What are your hours?",
        at: 4000,
      },
    ]);
  });

  it("rejects an invalid stored role", async () => {
    await expect(
      Effect.runPromise(
        encodeTurnSnapshots([
          {
            room: "r-a",
            seq: 1,
            role: "invalid" as never,
            text: "private",
            at: new Date(0),
          },
        ]),
      ),
    ).rejects.toThrow();
  });
});
