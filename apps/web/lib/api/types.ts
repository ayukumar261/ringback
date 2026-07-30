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
  started_at?: number // unix ms
  ended_at?: number // unix ms
  duration_ms?: number
}

// CallStartedEvent mirrors the call.started SSE payload.
export interface CallStartedEvent {
  event: "call.started"
  room: string
  conversation_id?: string
  from?: string
  to?: string
  started_at: number
}

// CallEndedEvent mirrors the call.ended SSE payload.
export interface CallEndedEvent {
  event: "call.ended"
  room: string
  ended_at: number
  duration_ms: number
}

export type CallEvent = CallStartedEvent | CallEndedEvent
