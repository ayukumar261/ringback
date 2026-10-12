// The browser reaches the api through same-origin /api in every environment.
export const API_URL = "/api"

// Cache keys double as api paths; fetcher and EventSource prepend API_URL.
export const CALLS_KEY = "/calls"
export const CALL_EVENTS_KEY = "/calls/events"
export const turnsKey = (room: string) =>
  `/calls/${encodeURIComponent(room)}/turns`

// audioUrl is the full recording url for the audio element, not a cache key.
export const audioUrl = (room: string) =>
  `${API_URL}/calls/${encodeURIComponent(room)}/audio`
