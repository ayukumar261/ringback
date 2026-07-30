import { Effect, PubSub } from "effect";
import type { CallEvent } from "../events/index.js";

// FeedEvent is one materialized call event tagged with its stream entry id.
export interface FeedEvent {
  readonly id: string;
  readonly event: CallEvent;
}

// CallFeed fans freshly materialized events out to live SSE subscribers.
export class CallFeed extends Effect.Service<CallFeed>()("api/CallFeed", {
  // sliding: a stuck subscriber loses oldest events rather than stalling the materializer
  effect: PubSub.sliding<FeedEvent>(1024),
}) {}
