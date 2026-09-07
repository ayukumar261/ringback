// API_URL is the ringback api origin. NEXT_PUBLIC_ vars are inlined at build time.
export const API_URL =
  process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001"

// Cache keys double as api paths; fetcher and EventSource prepend API_URL.
export const CALLS_KEY = "/calls"
export const CALL_EVENTS_KEY = "/calls/events"
export const turnsKey = (room: string) =>
  `/calls/${encodeURIComponent(room)}/turns`

// audioUrl is the full recording url for the audio element, not a cache key.
export const audioUrl = (room: string) =>
  `${API_URL}/calls/${encodeURIComponent(room)}/audio`
