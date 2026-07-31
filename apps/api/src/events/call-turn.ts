import { Effect, Schema } from "effect";
import { MongoClient } from "../clients/mongo.js";

// CallTurn mirrors the worker's call.turn stream entry.
export const CallTurn = Schema.Struct({
  event: Schema.Literal("call.turn"),
  room: Schema.NonEmptyString,
  seq: Schema.NumberFromString,
  role: Schema.Literal("caller", "agent"),
  text: Schema.String,
  at: Schema.NumberFromString,
});
export type CallTurn = typeof CallTurn.Type;

// applyCallTurn upserts one turn by (room, seq): corrections and replays just overwrite.
export const applyCallTurn = (mongo: MongoClient, ev: CallTurn) =>
  Effect.tryPromise(() =>
    mongo.turns.updateOne(
      { room: ev.room, seq: ev.seq },
      { $set: { role: ev.role, text: ev.text, at: new Date(ev.at) } },
      { upsert: true },
    ),
  );
