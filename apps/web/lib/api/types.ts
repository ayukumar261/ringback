// Wire types for the ringback api, duplicated by hand: the source of truth is
// CallSnapshot in apps/api/src/handlers/calls.ts and the event schemas in
// apps/api/src/events/ (apps/api emits no type declarations to import from).

// Call is one materialized call as served by GET /calls.
export interface Call {
  room: string
  status: "active" | "ended"
  conversation_id?: string
  from?: string
  to?: string
  direction?: string
  prompt?: string
  started_at?: number // unix ms
  ended_at?: number // unix ms
  duration_ms?: number
  audio?: string // recording file name, set on call.ended and empty when recording was off
  audio_started_at?: number // unix ms of the recording's first frame
}

// Turn is one transcript turn as served by GET /calls/:room/turns.
export interface Turn {
  room: string
  seq: number
  role: "user" | "agent" | "tool"
  text: string
  at: number // unix ms
  started_at?: number // unix ms on the recording's clock
  ended_at?: number // unix ms on the recording's clock
  duration_ms?: number
}

// CallStartedEvent mirrors the call.started SSE payload.
export interface CallStartedEvent {
  event: "call.started"
  room: string
  conversation_id?: string
  from?: string
  to?: string
  direction?: string
  prompt?: string
  started_at: number
}

// CallEndedEvent mirrors the call.ended SSE payload.
export interface CallEndedEvent {
  event: "call.ended"
  room: string
  ended_at: number
  duration_ms: number
  audio?: string
  audio_started_at?: number
}

// CallTurnEvent mirrors the call.turn SSE payload; a repeated seq updates text or timing.
export interface CallTurnEvent extends Turn {
  event: "call.turn"
}

export type CallEvent = CallStartedEvent | CallEndedEvent | CallTurnEvent
