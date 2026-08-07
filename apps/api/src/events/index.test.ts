import { Effect, Either } from "effect";
import { describe, expect, it } from "vitest";
import { decodeCallEvent, entryFields } from "./index.js";

// decode runs the schema synchronously, keeping failures as values.
const decode = (fields: Record<string, string>) =>
  Effect.runSync(Effect.either(decodeCallEvent(fields)));

describe("entryFields", () => {
  it("pairs a flat field array into a record", () => {
    expect(entryFields(["event", "call.started", "room", "r1"])).toEqual({
      event: "call.started",
      room: "r1",
    });
  });

  it("drops a trailing key with no value", () => {
    expect(entryFields(["a", "1", "b"])).toEqual({ a: "1" });
  });

  it("returns an empty record for no fields", () => {
    expect(entryFields([])).toEqual({});
  });

  it("keeps the last value of a repeated key", () => {
    expect(entryFields(["a", "1", "a", "2"])).toEqual({ a: "2" });
  });
});

describe("decodeCallEvent", () => {
  it("decodes call.started, parsing the timestamp", () => {
    const ev = decode({
      event: "call.started",
      room: "r1",
      conversation_id: "c1",
      from: "+15550001111",
      to: "+15550002222",
      direction: "inbound",
      started_at: "1722300000000",
    });
    expect(Either.getOrThrow(ev)).toEqual({
      event: "call.started",
      room: "r1",
      conversation_id: "c1",
      from: "+15550001111",
      to: "+15550002222",
      direction: "inbound",
      started_at: 1722300000000,
    });
  });

  it("decodes call.started without the optional fields", () => {
    const ev = decode({ event: "call.started", room: "r1", started_at: "1" });
    expect(Either.getOrThrow(ev)).toEqual({
      event: "call.started",
      room: "r1",
      started_at: 1,
    });
  });

  it("decodes call.turn, parsing seq and timestamp", () => {
    const ev = decode({
      event: "call.turn",
      room: "r1",
      seq: "3",
      role: "agent",
      text: "How can I help?",
      at: "1722300030000",
    });
    expect(Either.getOrThrow(ev)).toEqual({
      event: "call.turn",
      room: "r1",
      seq: 3,
      role: "agent",
      text: "How can I help?",
      at: 1722300030000,
    });
  });

  it("rejects a call.turn with an unknown role", () => {
    const ev = decode({
      event: "call.turn",
      room: "r1",
      seq: "1",
      role: "operator",
      text: "hi",
      at: "1",
    });
    expect(Either.isLeft(ev)).toBe(true);
  });

  it("rejects a call.turn with a non-numeric seq", () => {
    const ev = decode({
      event: "call.turn",
      room: "r1",
      seq: "first",
      role: "caller",
      text: "hi",
      at: "1",
    });
    expect(Either.isLeft(ev)).toBe(true);
  });

  it("decodes call.ended, parsing timestamp and duration", () => {
    const ev = decode({
      event: "call.ended",
      room: "r1",
      ended_at: "1722300060000",
      duration_ms: "60000",
    });
    expect(Either.getOrThrow(ev)).toEqual({
      event: "call.ended",
      room: "r1",
      ended_at: 1722300060000,
      duration_ms: 60000,
    });
  });

  it("ignores unknown fields, so the worker can add some later", () => {
    const ev = decode({
      event: "call.started",
      room: "r1",
      started_at: "1",
      future_field: "x",
    });
    expect(Either.getOrThrow(ev)).toEqual({
      event: "call.started",
      room: "r1",
      started_at: 1,
    });
  });

  it("rejects an unknown event type", () => {
    const ev = decode({ event: "call.rang", room: "r1", started_at: "1" });
    expect(Either.isLeft(ev)).toBe(true);
  });

  it("rejects an empty room", () => {
    const ev = decode({ event: "call.started", room: "", started_at: "1" });
    expect(Either.isLeft(ev)).toBe(true);
  });

  it("rejects a non-numeric timestamp", () => {
    const ev = decode({ event: "call.started", room: "r1", started_at: "x" });
    expect(Either.isLeft(ev)).toBe(true);
  });
});
