import { Schema } from "effect";

// CallUnanswered mirrors the worker's call.unanswered stream entry: the call ended before anyone answered.
export const CallUnanswered = Schema.Struct({
  event: Schema.Literal("call.unanswered"),
  room: Schema.NonEmptyString,
  ended_at: Schema.NumberFromString,
});
export type CallUnanswered = typeof CallUnanswered.Type;
