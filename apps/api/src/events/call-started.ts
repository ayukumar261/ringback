import { Effect, Schema } from "effect";
import { MongoClient } from "../clients/mongo.js";

// CallStarted mirrors the worker's call.started stream entry.
export const CallStarted = Schema.Struct({
  event: Schema.Literal("call.started"),
  room: Schema.NonEmptyString,
  conversation_id: Schema.optional(Schema.String),
  from: Schema.optional(Schema.String),
  to: Schema.optional(Schema.String),
  started_at: Schema.NumberFromString,
});
export type CallStarted = typeof CallStarted.Type;

// applyCallStarted records a new active call, safe to repeat.
export const applyCallStarted = (mongo: MongoClient, ev: CallStarted) =>
  Effect.tryPromise(() =>
    mongo.calls.updateOne(
      { room: ev.room },
      {
        // status only ever inserts, so a replayed start never revives an ended call
        $setOnInsert: {
          status: "active" as const,
          startedAt: new Date(ev.started_at),
        },
        $set: {
          conversationId: ev.conversation_id ?? "",
          from: ev.from ?? "",
          to: ev.to ?? "",
        },
      },
      { upsert: true },
    ),
  );
