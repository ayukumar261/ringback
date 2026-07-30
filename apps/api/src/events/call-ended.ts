import { Effect, Schema } from "effect";
import { MongoClient } from "../clients/mongo.js";

// CallEnded mirrors the worker's call.ended stream entry.
export const CallEnded = Schema.Struct({
  event: Schema.Literal("call.ended"),
  room: Schema.NonEmptyString,
  ended_at: Schema.NumberFromString,
  duration_ms: Schema.NumberFromString,
});
export type CallEnded = typeof CallEnded.Type;

// applyCallEnded closes a call out, safe to repeat.
export const applyCallEnded = (mongo: MongoClient, ev: CallEnded) =>
  Effect.tryPromise(() =>
    mongo.calls.updateOne(
      { room: ev.room },
      {
        $set: {
          status: "ended" as const,
          endedAt: new Date(ev.ended_at),
          durationMs: ev.duration_ms,
        },
      },
      { upsert: true },
    ),
  );
