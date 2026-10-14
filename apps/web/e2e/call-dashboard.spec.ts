import { expect, test } from "./support/fixtures"
import { recordingSeconds, tokens } from "./support/mock-api"
import { web } from "./support/servers"

// Browser tests exercise real cookies and navigation against a controlled API.
// The actual Effect router's authorization, ranges, and SSE are tested in apps/api.

test("private link becomes a cookie and survives refresh and Checkout return", async ({
  page,
  context,
  api,
}) => {
  await page.goto(`/call/a#token=${tokens.a}`)
  await expect(page.getByText("Private task for a")).toBeVisible()
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
  await page.reload()
  await expect(page.getByText("Private task for a")).toBeVisible()
  await page.getByRole("link", { name: "Continue to payment" }).click()
  await page.getByRole("link", { name: "Return to call" }).click()
  await expect(
    page.getByRole("heading", { name: "Your call is queued" })
  ).toBeVisible()
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
    page.getByRole("heading", { name: "This call is locked or unavailable" })
  ).toBeVisible()
  await expect(page.getByText("Private task for a")).toHaveCount(0)
  await page.goto(`/call/a#token=${tokens.b}`)
  await expect(
    page.getByRole("heading", { name: "This call is locked or unavailable" })
  ).toBeVisible()
  await page.goto("/")
  await expect(
    page.getByText("Every call has its own private space.")
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
    page.getByRole("heading", { name: "This call is locked or unavailable" })
  ).toBeVisible()
  await expect(page.getByText("Private task for a")).toHaveCount(0)
})

test("recording ranges, transcript seeking, and mobile layout work after reload", async ({
  page,
  api,
}) => {
  api.ended = true
  await page.goto(`/call/a#token=${tokens.a}`)
  await expect(
    page.getByRole("heading", { name: "Call complete" })
  ).toBeVisible()
  await expect(page.getByText("Transcript for a")).toBeVisible()
  const audio = page.locator("audio")
  await expect
    .poll(() => audio.evaluate((el: HTMLAudioElement) => el.duration))
    .toBe(recordingSeconds)
  await page.getByRole("button", { name: /Recipient.*0:02/ }).click()
  await expect
    .poll(() => audio.evaluate((el: HTMLAudioElement) => el.currentTime))
    .toBe(2)
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
