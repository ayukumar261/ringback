import { Schema } from "effect";

// TurnSnapshot encodes a TurnDoc into the snake_case, unix-ms SSE wire dialect.
export const TurnSnapshot = Schema.Struct({
  room: Schema.String,
  seq: Schema.Number,
  role: Schema.Literal("user", "agent", "tool"),
  text: Schema.String,
  at: Schema.DateFromNumber,
  startedAt: Schema.optional(Schema.DateFromNumber).pipe(
    Schema.fromKey("started_at"),
  ),
  endedAt: Schema.optional(Schema.DateFromNumber).pipe(
    Schema.fromKey("ended_at"),
  ),
  durationMs: Schema.optional(Schema.Number).pipe(
    Schema.fromKey("duration_ms"),
  ),
});

// encodeTurnSnapshots encodes turn docs for the wire.
export const encodeTurnSnapshots = Schema.encode(Schema.Array(TurnSnapshot));
