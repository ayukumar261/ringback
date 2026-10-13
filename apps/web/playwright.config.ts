import { defineConfig, devices } from "@playwright/test"
import { callEventsServer, web } from "./e2e/support/servers"

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 2,
  use: {
    baseURL: web.url,
    trace: "retain-on-failure",
    ...devices["Desktop Chrome"],
  },
  webServer: [
    {
      command: "pnpm --filter api start:e2e",
      url: `${callEventsServer.url}/health`,
      env: {
        HOST: callEventsServer.host,
        PORT: String(callEventsServer.port),
        E2E_CALL_ID: callEventsServer.callId,
        E2E_CALL_TOKEN: callEventsServer.token,
      },
      reuseExistingServer: false,
    },
    {
      // Exercise the deployed caching behavior; Next dev overrides cache headers.
      command: [
        "pnpm build",
        "cp -R .next/static .next/standalone/apps/web/.next/",
        "cp -R public .next/standalone/apps/web/",
        "node .next/standalone/apps/web/server.js",
      ].join(" && "),
      url: web.url,
      // Startup includes the production build.
      timeout: 120_000,
      env: {
        RINGBACK_API_UPSTREAM: callEventsServer.url,
        HOSTNAME: web.host,
        PORT: String(web.port),
      },
      reuseExistingServer: false,
    },
  ],
})
