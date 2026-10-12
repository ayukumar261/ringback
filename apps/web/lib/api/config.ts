// Browser reads and call-scoped cookies share this origin in every environment.
export const API_URL = "/api"
export const callKey = (id: string) => `/call/${encodeURIComponent(id)}`
export const turnsKey = (id: string) => `${callKey(id)}/turns`
export const eventsUrl = (id: string) => `${API_URL}${callKey(id)}/events`
export const audioUrl = (id: string) => `${API_URL}${callKey(id)}/audio`
