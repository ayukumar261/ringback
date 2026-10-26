import { expect, test } from "./support/fixtures"
import { mockApi, recordingSeconds, tokens } from "./support/mock-api"
import { web } from "./support/servers"

// Browser tests exercise real cookies and navigation against a controlled API.
// The actual Effect router's authorization, ranges, and SSE are tested in apps/api.

test("unpaid Checkout expires on screen even before the API reports expiry", async ({
  page,
  api,
}) => {
  const now = new Date()
  api.checkoutExpiresAt = new Date(now.getTime() + 60 * 60_000).toISOString()
  await page.clock.install({ time: now })
  await page.goto(`/call/a#token=${tokens.a}`)
  const payment = page.getByRole("link", { name: "Continue to payment" })
  await expect(payment).toBeVisible()
  await page.clock.fastForward(60 * 60_000)
  await expect(payment).toHaveCount(0)
  await expect(page.getByLabel("Call details")).toContainText(
    '"status": "expired"'
  )
  await expect(page.getByText("Private task for a")).toBeVisible()
  // An authoritative paid response still wins if payment finished at the deadline.
  api.stage = "paid"
  await page.clock.runFor(5_001)
  await expect(page.getByLabel("Call details")).toContainText(
    '"status": "paid"'
  )
})

test("live debug transcript follows new turns and corrections", async ({
  page,
  api,
}) => {
  const currentTurn = page.locator('li[aria-current="time"]')
  api.stage = "active"
  await page.clock.install()
  await page.goto(`/call/a#token=${tokens.a}`)
  await expect(page.getByLabel("Call details")).toContainText(
    '"status": "active"'
  )
  await expect(page.getByText("no turns yet")).toBeVisible()
  api.turns = [
    {
      room: "room-a",
      seq: 1,
      role: "agent",
      text: "Checking the time.",
      at: 1000,
    },
  ]
  // Run timers in order so SWR clears its deduplication window before polling.
  await page.clock.runFor(15_001)
  await expect(currentTurn).toContainText("Checking the time.")
  api.turns = [{ ...api.turns[0]!, text: "Checking the appointment time." }]
  await page.clock.runFor(15_001)
  await expect(page.locator("li")).toHaveCount(1)
  await expect(currentTurn).toContainText("Checking the appointment time.")
  await expect(
    page.getByRole("button", { name: /Checking the appointment time/ })
  ).toBeDisabled()
})

test("private link becomes a cookie and survives refresh and Checkout return", async ({
  page,
  context,
  api,
  browser,
}) => {
  await page.goto(`/call/a#token=${tokens.a}`)
  await expect(page.getByText("Private task for a")).toBeVisible()
  await expect(page).toHaveTitle("Call")
  await expect(page.locator("main")).toHaveCSS("font-size", "12px")
  await expect(page.getByLabel("Call details")).toContainText(
    '"status": "unpaid"'
  )
  expect(await page.locator("body").innerText()).not.toMatch(/ringback|corbyn/i)
  expect(await page.locator("head").innerHTML()).not.toMatch(/ringback|corbyn/i)
  await expect(page).toHaveURL("/call/a")
  const cookies = await context.cookies(`${web.url}/api/call/a`)
  expect(cookies).toMatchObject([
    {
      name: "ringback_access",
      value: tokens.a,
      httpOnly: true,
      path: "/api/call/a",
      sameSite: "Lax",
    },
  ])
  expect(await context.cookies(`${web.url}/api/call/b`)).toEqual([])
  expect(
    await page.evaluate(() => JSON.stringify({ ...localStorage }))
  ).not.toContain(tokens.a)
  expect(api.requests.every(({ url }) => !url.includes(tokens.a))).toBe(true)
  await expect(
    page.getByRole("region", { name: "Payment confirmed" })
  ).toHaveCount(0)
  await page.reload()
  await expect(page.getByText("Private task for a")).toBeVisible()
  await page.getByRole("link", { name: "Continue to payment" }).click()
  await page.getByRole("link", { name: "Return to call" }).click()
  await expect(page.getByLabel("Call details")).toContainText(
    '"status": "paid"'
  )
  const confirmation = page.getByRole("region", { name: "Payment confirmed" })
  await expect(confirmation).toContainText(
    "Send the user their dashboard URL now"
  )
  const shareUrl = `${web.url}/call/a#token=${tokens.a}`
  await expect(confirmation.getByRole("link")).toHaveAttribute("href", shareUrl)
  await expect(confirmation.getByRole("link")).toHaveText(shareUrl)

  const userContext = await browser.newContext()
  try {
    const userApi = await mockApi(userContext)
    userApi.stage = "paid"
    const userPage = await userContext.newPage()
    await userPage.goto(shareUrl)
    await expect(userPage.getByText("Private task for a")).toBeVisible()
    await expect(userPage).toHaveURL("/call/a")
  } finally {
    await userContext.close()
  }
})

test("anonymous pages and wrong links reveal no private details", async ({
  page,
}) => {
  const response = await page.goto("/call/a")
  expect(response?.headers()["x-robots-tag"]).toContain("noindex")
  expect(response?.headers()["referrer-policy"]).toBe("no-referrer")
  expect(response?.headers()["cache-control"]).toContain("no-store")
  expect(await response!.text()).not.toContain("Private task")
  await expect(
    page.getByRole("status", { name: "Call unavailable" })
  ).toBeVisible()
  expect(await page.locator("body").innerText()).not.toMatch(/ringback|corbyn/i)
  await expect(page.getByText("Private task for a")).toHaveCount(0)
  await page.goto(`/call/a#token=${tokens.b}`)
  await expect(
    page.getByRole("status", { name: "Call unavailable" })
  ).toBeVisible()
  await page.goto("/")
  await expect(
    page.getByRole("heading", { level: 1, name: "Introduction" })
  ).toBeVisible()
  await expect(page.getByText("Private task for a")).toHaveCount(0)
})

test("two tabs retain independent grants and unauthorized routes clear displayed data", async ({
  page,
  context,
  api,
}) => {
  await context.clock.install()
  await page.goto(`/call/a#token=${tokens.a}`)
  await expect(page.getByText("Private task for a")).toBeVisible()
  const second = await context.newPage()
  await second.goto(`/call/b#token=${tokens.b}`)
  await expect(second.getByText("Private task for b")).toBeVisible()
  await page.reload()
  await expect(page.getByText("Private task for a")).toBeVisible()
  expect(
    (await context.cookies()).filter((c) => c.name === "ringback_access")
  ).toHaveLength(2)
  api.revoked = true
  // Revocation surfaces on the dashboard's 5 s poll; skip the wait.
  await page.clock.fastForward(5_000)
  await expect(
    page.getByRole("status", { name: "Call unavailable" })
  ).toBeVisible()
  await expect(page.getByText("Private task for a")).toHaveCount(0)
})

test("recording ranges, transcript seeking, and mobile layout work after reload", async ({
  page,
  api,
}) => {
  api.stage = "ended"
  await page.goto(`/call/a#token=${tokens.a}`)
  await expect(page.getByLabel("Call details")).toContainText(
    '"status": "ended"'
  )
  await expect(page.getByText("Transcript for a")).toBeVisible()
  const audio = page.locator("audio")
  await expect
    .poll(() => audio.evaluate((el: HTMLAudioElement) => el.duration))
    .toBe(recordingSeconds)
  await page.getByRole("button", { name: /0:02 user/ }).click()
  await expect
    .poll(() => audio.evaluate((el: HTMLAudioElement) => el.currentTime))
    .toBe(2)
  await expect(page.locator('li[aria-current="time"]')).toContainText(
    "Yes, the appointment is confirmed."
  )
  expect(
    api.requests.some(
      (r) => r.url.endsWith("/audio") && r.cookie.includes(tokens.a) && r.range
    )
  ).toBe(true)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.reload()
  await expect(page.getByText("Transcript for a")).toBeVisible()
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth
    )
  ).toBe(true)
})
