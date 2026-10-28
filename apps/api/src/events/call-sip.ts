import { Schema } from "effect";

// CallSip mirrors the worker's call.sip stream entry. It only feeds expense
// tracking and never reaches the customer's feed.
export const CallSip = Schema.Struct({
  event: Schema.Literal("call.sip"),
  room: Schema.NonEmptyString,
  call_sid: Schema.NonEmptyString,
  at: Schema.NumberFromString,
});
export type CallSip = typeof CallSip.Type;
