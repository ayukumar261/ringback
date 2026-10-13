// The one source for e2e addresses and the synthetic call. playwright.config.ts
// passes callEventsServer to apps/api/e2e/call-events-server.ts through env.
const local = (port: number) => ({
  host: "127.0.0.1",
  port,
  url: `http://127.0.0.1:${port}`,
})

export const web = local(3100)

export const callEventsServer = {
  ...local(3199),
  callId: "proxy-test",
  token: Buffer.alloc(32, 3).toString("base64url"),
}
