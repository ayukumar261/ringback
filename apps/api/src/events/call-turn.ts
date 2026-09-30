import { Effect, Schema } from "effect";
import { MongoClient } from "../clients/mongo.js";

// CallTurn mirrors the worker's call.turn stream entry.
export const CallTurn = Schema.Struct({
  event: Schema.Literal("call.turn"),
  room: Schema.NonEmptyString,
  seq: Schema.NumberFromString,
  role: Schema.Literal("user", "agent", "tool"),
  text: Schema.String,
  at: Schema.NumberFromString,
  started_at: Schema.optional(Schema.NumberFromString),
  ended_at: Schema.optional(Schema.NumberFromString),
  duration_ms: Schema.optional(Schema.NumberFromString),
});
export type CallTurn = typeof CallTurn.Type;

// applyCallTurn upserts one turn by (room, seq), preserving timing omitted by a correction.
export const applyCallTurn = (mongo: MongoClient, ev: CallTurn) =>
  Effect.tryPromise(() =>
    mongo.turns.updateOne(
      { room: ev.room, seq: ev.seq },
      {
        $set: {
          role: ev.role,
          text: ev.text,
          at: new Date(ev.at),
          ...(ev.started_at !== undefined && {
            startedAt: new Date(ev.started_at),
          }),
          ...(ev.ended_at !== undefined && {
            endedAt: new Date(ev.ended_at),
          }),
          ...(ev.duration_ms !== undefined && { durationMs: ev.duration_ms }),
        },
      },
      { upsert: true },
    ),
  );
