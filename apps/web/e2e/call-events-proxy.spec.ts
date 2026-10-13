import { expect, test } from "@playwright/test"
import { callEventsServer } from "./support/servers"

test("the production proxy delivers private SSE frames without compression buffering", async ({
  page,
}) => {
  await page.goto("/")
  const result = await page.evaluate(async ({ callId, token }) => {
    const response = await fetch(`/api/call/${callId}/events`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(3000),
    })
    const reader = response
      .body!.pipeThrough(new TextDecoderStream())
      .getReader()
    // A proxy may split or merge chunks, so collect whole frames until ready.
    const frames: string[] = []
    let partial = ""
    try {
      while (!frames.some((frame) => frame.startsWith("event: ready"))) {
        const { value, done } = await reader.read()
        if (done) break
        const parts = (partial + value).split("\n\n")
        partial = parts.pop() ?? ""
        frames.push(...parts)
      }
      return {
        status: response.status,
        encoding: response.headers.get("content-encoding"),
        cacheControl: response.headers.get("cache-control"),
        frames,
      }
    } finally {
      await reader.cancel()
    }
  }, callEventsServer)
  expect(result.status).toBe(200)
  expect(result.encoding).toBeNull()
  expect(result.cacheControl).toBe("no-store, no-transform")
  expect(result.frames).toContain("event: ready\ndata: {}")
})
