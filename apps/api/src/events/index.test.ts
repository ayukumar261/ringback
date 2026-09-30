import { Effect, Either } from "effect";
import { describe, expect, it } from "vitest";
import type { MongoClient } from "../clients/mongo.js";
import {
  applyCallEvent,
  type CallEvent,
  decodeCallEvent,
  entryFields,
} from "./index.js";

// decode runs the schema synchronously, keeping failures as values.
const decode = (fields: Record<string, string>) =>
  Effect.runSync(Effect.either(decodeCallEvent(fields)));

// Apply either collection's update without depending on its driver result type.
const apply = (mongo: MongoClient, event: CallEvent) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* applyCallEvent(mongo, event);
    }),
  );

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
      direction: "outbound",
      prompt: "Order a pizza.",
      started_at: "1722300000000",
    });
    expect(Either.getOrThrow(ev)).toEqual({
      event: "call.started",
      room: "r1",
      conversation_id: "c1",
      from: "+15550001111",
      to: "+15550002222",
      direction: "outbound",
      prompt: "Order a pizza.",
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

  it("decodes a call.turn with the tool role", () => {
    const ev = decode({
      event: "call.turn",
      room: "r1",
      seq: "3",
      role: "tool",
      text: "pressed 1",
      at: "1722300030000",
    });
    expect(Either.isRight(ev)).toBe(true);
  });

  it.each(["agent", "tool"])("decodes a %s turn's recording span", (role) => {
    const ev = decode({
      event: "call.turn",
      room: "r1",
      seq: "3",
      role,
      text: "Hello",
      at: "1500",
      started_at: "1000",
      ended_at: "1400",
      duration_ms: "400",
    });
    expect(Either.getOrThrow(ev)).toStrictEqual({
      event: "call.turn",
      room: "r1",
      seq: 3,
      role,
      text: "Hello",
      at: 1500,
      started_at: 1000,
      ended_at: 1400,
      duration_ms: 400,
    });
  });

  it.each(["started_at", "ended_at", "duration_ms"])(
    "rejects a non-numeric turn %s",
    (field) => {
      expect(
        Either.isLeft(
          decode({
            event: "call.turn",
            room: "r1",
            seq: "1",
            role: "agent",
            text: "Hello",
            at: "1",
            [field]: "invalid",
          }),
        ),
      ).toBe(true);
    },
  );

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
      role: "user",
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
      audio: "r1.wav",
    });
    expect(Either.getOrThrow(ev)).toEqual({
      event: "call.ended",
      room: "r1",
      ended_at: 1722300060000,
      duration_ms: 60000,
      audio: "r1.wav",
    });
  });

  it("decodes call.ended without audio", () => {
    const ev = decode({
      event: "call.ended",
      room: "r1",
      ended_at: "1",
      duration_ms: "1",
    });
    expect(Either.getOrThrow(ev)).toEqual({
      event: "call.ended",
      room: "r1",
      ended_at: 1,
      duration_ms: 1,
    });
  });

  it("decodes the recording start on call.ended", () => {
    expect(
      Either.getOrThrow(
        decode({
          event: "call.ended",
          room: "r1",
          ended_at: "1000",
          duration_ms: "900",
          audio: "r1.wav",
          audio_started_at: "0",
        }),
      ),
    ).toStrictEqual({
      event: "call.ended",
      room: "r1",
      ended_at: 1000,
      duration_ms: 900,
      audio: "r1.wav",
      audio_started_at: 0,
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

// storedCollection applies Mongo's $set semantics and exposes each write.
const storedCollection = () => {
  const doc: Record<string, unknown> = {};
  const writes: unknown[] = [];
  return {
    doc,
    writes,
    updateOne: (
      filter: Record<string, unknown>,
      update: { $set: Record<string, unknown> },
      options: unknown,
    ) => {
      writes.push({ filter, update, options });
      Object.assign(doc, filter, update.$set);
      return Promise.resolve({});
    },
  };
};

describe("applyCallEvent timing", () => {
  it.each(["agent", "tool"])(
    "keeps a %s span when a later correction omits it",
    async (role) => {
      const turns = storedCollection();
      const mongo = { turns } as unknown as MongoClient;
      const fields = {
        event: "call.turn",
        room: "r1",
        seq: "3",
        role,
        text: "Hello there",
        at: "900",
      };
      const applyFields = async (extra: Record<string, string>) => {
        const ev = Either.getOrThrow(decode({ ...fields, ...extra }));
        await apply(mongo, ev);
      };

      await applyFields({ started_at: "1000" });
      expect(turns.doc).toStrictEqual({
        room: "r1",
        seq: 3,
        role,
        text: "Hello there",
        at: new Date(900),
        startedAt: new Date(1000),
      });
      await applyFields({ ended_at: "1400", duration_ms: "400" });
      await applyFields({ text: "Hello" });
      expect(turns.doc).toStrictEqual({
        room: "r1",
        seq: 3,
        role,
        text: "Hello",
        at: new Date(900),
        startedAt: new Date(1000),
        endedAt: new Date(1400),
        durationMs: 400,
      });
      expect(turns.writes.at(-1)).toStrictEqual({
        filter: { room: "r1", seq: 3 },
        update: { $set: { role, text: "Hello", at: new Date(900) } },
        options: { upsert: true },
      });

      // A real timing update replaces saved values, including a zero-length span.
      await applyFields({ started_at: "0", ended_at: "0", duration_ms: "0" });
      expect(turns.doc).toMatchObject({
        startedAt: new Date(0),
        endedAt: new Date(0),
        durationMs: 0,
      });
    },
  );

  it("stores all three span fields from one decoded event", async () => {
    const turns = storedCollection();
    const ev = Either.getOrThrow(
      decode({
        event: "call.turn",
        room: "r1",
        seq: "1",
        role: "agent",
        text: "Hello",
        at: "500",
        started_at: "1000",
        ended_at: "1500",
        duration_ms: "500",
      }),
    );
    await apply({ turns } as unknown as MongoClient, ev);
    expect(turns.doc).toStrictEqual({
      room: "r1",
      seq: 1,
      role: "agent",
      text: "Hello",
      at: new Date(500),
      startedAt: new Date(1000),
      endedAt: new Date(1500),
      durationMs: 500,
    });
  });

  it("keeps turns with no audio free of span fields", async () => {
    const turns = storedCollection();
    const ev = Either.getOrThrow(
      decode({
        event: "call.turn",
        room: "r1",
        seq: "1",
        role: "user",
        text: "Hi",
        at: "500",
      }),
    );
    await apply({ turns } as unknown as MongoClient, ev);
    expect(turns.doc).toStrictEqual({
      room: "r1",
      seq: 1,
      role: "user",
      text: "Hi",
      at: new Date(500),
    });
  });

  it("stores audioStartedAt and preserves it on an older call.ended replay", async () => {
    const calls = storedCollection();
    const mongo = { calls } as unknown as MongoClient;
    const fields = {
      event: "call.ended",
      room: "r1",
      ended_at: "1500",
      duration_ms: "1000",
      audio: "r1.wav",
    };
    await apply(
      mongo,
      Either.getOrThrow(
        decode({
          ...fields,
          audio_started_at: "0",
        }),
      ),
    );
    await apply(mongo, Either.getOrThrow(decode(fields)));
    expect(calls.doc).toStrictEqual({
      room: "r1",
      status: "ended",
      endedAt: new Date(1500),
      durationMs: 1000,
      audio: "r1.wav",
      audioStartedAt: new Date(0),
    });
  });
});
