import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import type { CallDoc } from "../../clients/mongo.js";
import { CallSnapshot, encodeCallSnapshots, eventCursor } from "./schema.js";

const activeDoc: CallDoc = {
  room: "r-a",
  status: "active",
  conversationId: "conv-1",
  from: "+15550001111",
  to: "+15550002222",
  direction: "outbound",
  prompt: "Order a pizza.",
  startedAt: new Date(1000),
};

const endedDoc: CallDoc = {
  room: "r-b",
  status: "ended",
  conversationId: "conv-2",
  from: "+15550003333",
  to: "+15550004444",
  startedAt: new Date(2000),
  endedAt: new Date(62000),
  durationMs: 60000,
  audio: "r-b.wav",
};

describe("CallSnapshot", () => {
  it("round-trips the recording start as unix milliseconds", async () => {
    const doc: CallDoc = { ...endedDoc, audioStartedAt: new Date(0) };
    const docs: CallDoc[] = [doc];
    const out = await Effect.runPromise(encodeCallSnapshots(docs));
    expect(out[0]).toHaveProperty("audio_started_at", 0);
    expect(Schema.decodeUnknownSync(CallSnapshot)(out[0])).toStrictEqual(doc);
  });

  it("encodes docs into the SSE wire dialect", async () => {
    const docs: CallDoc[] = [endedDoc, activeDoc];
    const out = await Effect.runPromise(encodeCallSnapshots(docs));
    expect(out).toEqual([
      {
        room: "r-b",
        status: "ended",
        conversation_id: "conv-2",
        from: "+15550003333",
        to: "+15550004444",
        started_at: 2000,
        ended_at: 62000,
        duration_ms: 60000,
        audio: "r-b.wav",
      },
      {
        room: "r-a",
        status: "active",
        conversation_id: "conv-1",
        from: "+15550001111",
        to: "+15550002222",
        direction: "outbound",
        prompt: "Order a pizza.",
        started_at: 1000,
      },
    ]);
  });

  it("omits absent optional fields", async () => {
    const docs: CallDoc[] = [
      {
        room: "r-x",
        status: "ended",
        endedAt: new Date(5000),
        durationMs: 100,
      },
    ];
    const out = await Effect.runPromise(encodeCallSnapshots(docs));
    expect(Object.keys(out[0] ?? {}).sort()).toEqual([
      "duration_ms",
      "ended_at",
      "room",
      "status",
    ]);
  });

  it("rejects an invalid stored status", async () => {
    await expect(
      Effect.runPromise(
        encodeCallSnapshots([{ room: "r-a", status: "invalid" as never }]),
      ),
    ).rejects.toThrow();
  });
});

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
