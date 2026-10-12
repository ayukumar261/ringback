// Explicit wire types for the call API. Billing fields stay server-side.
export interface Call {
  call_id: string
  status: "unpaid" | "paid" | "dialing" | "dialed" | "expired" | "failed"
  to: string
  prompt: string
  amount: number
  currency: string
  max_duration_seconds: number
  created_at: string
  access_expires_at: string
  checkout_expires_at: string
  checkout_url: string | null
  call: {
    status: "active" | "ended"
    started_at?: number
    ended_at?: number
    duration_ms?: number
    audio_available: boolean
    audio_started_at?: number
  } | null
}

export interface Turn {
  room: string
  seq: number
  role: "user" | "agent" | "tool"
  text: string
  at: number
  started_at?: number
  ended_at?: number
  duration_ms?: number
}
