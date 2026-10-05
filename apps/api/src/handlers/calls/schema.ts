import { Schema } from "effect";

// CallSnapshot encodes a CallDoc into the snake_case, unix-ms SSE wire dialect.
export const CallSnapshot = Schema.Struct({
  room: Schema.String,
  status: Schema.Literal("active", "ended"),
  conversationId: Schema.optional(Schema.String).pipe(
    Schema.fromKey("conversation_id"),
  ),
  from: Schema.optional(Schema.String),
  to: Schema.optional(Schema.String),
  direction: Schema.optional(Schema.String),
  prompt: Schema.optional(Schema.String),
  startedAt: Schema.optional(Schema.DateFromNumber).pipe(
    Schema.fromKey("started_at"),
  ),
  endedAt: Schema.optional(Schema.DateFromNumber).pipe(
    Schema.fromKey("ended_at"),
  ),
  durationMs: Schema.optional(Schema.Number).pipe(
    Schema.fromKey("duration_ms"),
  ),
  audio: Schema.optional(Schema.String),
  audioStartedAt: Schema.optional(Schema.DateFromNumber).pipe(
    Schema.fromKey("audio_started_at"),
  ),
});

// encodeCallSnapshots encodes call docs for the wire.
export const encodeCallSnapshots = Schema.encode(Schema.Array(CallSnapshot));

// eventCursor keeps a valid Last-Event-ID and drops anything else so the client starts fresh.
export const eventCursor = (value: string | undefined): string | undefined =>
  value !== undefined && /^\d+-\d+$/.test(value) ? value : undefined;
