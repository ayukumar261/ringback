import type { BrowserContext } from "@playwright/test"
import type { Call, Turn } from "@/lib/api/types"
import { web } from "./servers"
import { silentWav } from "./wav"

// Two calls, a and b, each unlocked by its own token.
export const tokens = {
  a: Buffer.alloc(32, 1).toString("base64url"),
  b: Buffer.alloc(32, 2).toString("base64url"),
}

export const recordingSeconds = 4

// Tests set the stage to move the mocked call through its lifecycle.
export interface MockApi {
  stage: "unpaid" | "paid" | "active" | "ended"
  revoked: boolean
  turns?: Turn[]
  requests: { url: string; cookie: string; range?: string }[]
}

const endedTurns = (id: string): Turn[] => [
  {
    room: `room-${id}`,
    seq: 1,
    role: "agent",
    text: `Transcript for ${id}`,
    at: 1000,
    started_at: 1000,
  },
  {
    room: `room-${id}`,
    seq: 2,
    role: "user",
    text: "Yes, the appointment is confirmed.",
    at: 3000,
    started_at: 3000,
  },
]

export async function mockApi(context: BrowserContext): Promise<MockApi> {
  const state: MockApi = {
    stage: "unpaid",
    revoked: false,
    requests: [],
  }
  const expires = new Date(Date.now() + 3600_000).toISOString()
  await context.route("/api/**", async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const headers = await request.allHeaders()
    state.requests.push({
      url: request.url(),
      cookie: headers.cookie ?? "",
      range: headers.range,
    })
    const match = /^\/api\/call\/([ab])(\/.*)?$/.exec(url.pathname)
    const reply = (
      body: unknown,
      status = 200,
      extra: Record<string, string> = {}
    ) =>
      route.fulfill({
        status,
        json: body,
        headers: { "cache-control": "no-store", ...extra },
      })
    if (!match) return reply({ error: "not_found" }, 404)
    const id = match[1] as keyof typeof tokens
    const suffix = match[2] ?? ""
    const secret = tokens[id]
    if (suffix === "/access") {
      if (state.revoked || headers.authorization !== `Bearer ${secret}`)
        return reply({ error: "not_found" }, 404)
      return reply({ access_expires_at: expires }, 200, {
        "set-cookie": `ringback_access=${secret}; Path=/api/call/${id}; HttpOnly; SameSite=Lax; Expires=${new Date(expires).toUTCString()}`,
      })
    }
    if (state.revoked || headers.cookie !== `ringback_access=${secret}`)
      return reply({ error: "unauthorized" }, 401)
    if (suffix === "/events")
      return route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: "retry: 60000\n\n",
      })
    if (suffix === "/turns")
      return reply(
        state.turns ?? (state.stage === "ended" ? endedTurns(id) : [])
      )
    if (suffix === "/audio") {
      const bytes = silentWav(recordingSeconds)
      const range = /bytes=(\d+)-(\d*)/.exec(headers.range ?? "")
      const start = range ? Number(range[1]) : 0
      const end = range?.[2]
        ? Math.min(Number(range[2]), bytes.length - 1)
        : bytes.length - 1
      return route.fulfill({
        status: range ? 206 : 200,
        contentType: "audio/wav",
        body: bytes.subarray(start, end + 1),
        headers: {
          "accept-ranges": "bytes",
          "content-length": String(end - start + 1),
          ...(range && {
            "content-range": `bytes ${start}-${end}/${bytes.length}`,
          }),
        },
      })
    }
    const { stage } = state
    const dialed = stage === "active" || stage === "ended"
    return reply({
      call_id: id,
      status: dialed ? "dialed" : stage,
      to: "+15551234567",
      prompt: `Private task for ${id}`,
      amount: 50,
      currency: "usd",
      max_duration_seconds: 1800,
      created_at: new Date().toISOString(),
      access_expires_at: expires,
      checkout_expires_at: expires,
      checkout_url: stage === "unpaid" ? `${web.url}/checkout` : null,
      call: dialed
        ? {
            status: stage,
            started_at: 1000,
            ...(stage === "ended" && {
              ended_at: 1000 + recordingSeconds * 1000,
              duration_ms: recordingSeconds * 1000,
            }),
            audio_available: stage === "ended",
            audio_started_at: 1000,
          }
        : null,
    } satisfies Call)
  })
  await context.route("/checkout", async (route) => {
    state.stage = "paid"
    await route.fulfill({
      contentType: "text/html",
      body: '<a href="/call/a">Return to call</a>',
    })
  })
  return state
}
