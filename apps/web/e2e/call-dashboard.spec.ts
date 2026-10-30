import { expect, test } from "./support/fixtures"
import { handoffs, mockApi, recordingSeconds, tokens } from "./support/mock-api"
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
  await expect(
    page.getByRole("heading", { name: "This call wasn’t started" })
  ).toBeVisible()
  await expect(page.getByText("Private task for a")).toBeVisible()
  // An authoritative paid response still wins if payment finished at the deadline.
  api.stage = "paid"
  await page.clock.runFor(5_001)
  await expect(
    page.getByRole("heading", { name: "Getting the call ready" })
  ).toBeVisible()
})

test("live transcript follows new turns and corrections", async ({
  page,
  api,
}) => {
  const currentTurn = page.locator('li[aria-current="time"]')
  api.stage = "active"
  await page.clock.install()
  await page.goto(`/call/a#token=${tokens.a}`)
  await expect(
    page.getByRole("heading", { name: "The call is connected" })
  ).toBeVisible()
  await expect(page.getByRole("region", { name: "Recording" })).toBeVisible()
  for (const name of [
    "Play recording",
    "Back 10 seconds",
    "Forward 10 seconds",
    "Playback speed",
    "Download recording",
  ]) {
    await expect(page.getByRole("button", { name, exact: true })).toBeDisabled()
  }
  await expect(
    page.getByRole("slider", { name: "Recording position" })
  ).toBeDisabled()
  await expect(
    page.getByText("Playback is available after the call ends.")
  ).toBeVisible()
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
  await expect(page.getByRole("button", { name: /Seek to/ })).toHaveCount(0)
  expect(api.requests.some(({ url }) => url.endsWith("/audio"))).toBe(false)
  // The same controls become usable when the recording is ready after the call.
  api.stage = "ended"
  await page.clock.runFor(5_001)
  await expect(
    page.getByRole("button", { name: "Play recording", exact: true })
  ).toBeEnabled()
  await expect(
    page.getByRole("slider", { name: "Recording position" })
  ).toBeEnabled()
  await expect(
    page.getByText("Playback is available after the call ends.")
  ).toHaveCount(0)
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
  await expect(page.locator("main")).toHaveCSS("font-size", "14px")
  await expect(
    page.getByRole("heading", { name: "Ready when you are" })
  ).toBeVisible()
  await expect(
    page.getByRole("link", { name: "Corbyn AI", exact: true })
  ).toHaveAttribute("href", "/")
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
  await expect(
    page.getByRole("heading", { name: "Getting the call ready" })
  ).toBeVisible()
  await expect(
    page.getByRole("region", { name: "Payment confirmed" })
  ).toHaveCount(0)
  const shareUrl = `${web.url}/call/a#token=${tokens.a}`

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

test("direct Checkout returns to an unlocked dashboard and strips the handoff", async ({
  page,
  context,
  api,
}) => {
  await page.goto("/checkout")
  expect(await context.cookies(`${web.url}/api/call/a`)).toEqual([])
  await page.getByRole("link", { name: "Return to call" }).click()
  await expect(page.getByText("Private task for a")).toBeVisible()
  await expect(
    page.getByRole("heading", { name: "Getting the call ready" })
  ).toBeVisible()
  await expect(page).toHaveURL("/call/a")
  expect(api.handoffUsed.has("a")).toBe(true)
  expect(api.requests.every(({ url }) => !url.includes(handoffs.a))).toBe(true)
  expect(
    await page.evaluate(() => JSON.stringify({ ...localStorage }))
  ).not.toContain(handoffs.a)
  await page.reload()
  await expect(page.getByText("Private task for a")).toBeVisible()
  await context.clearCookies()
  await page.goto(`/call/a#handoff=${handoffs.a}`)
  await expect(
    page.getByRole("status", { name: "Call unavailable" })
  ).toBeVisible()
})

test("cancel then pay keeps access after the one-time handoff was spent", async ({
  page,
  api,
}) => {
  await page.goto("/checkout")
  await page.getByRole("link", { name: "Cancel payment" }).click()
  await expect(page.getByText("Private task for a")).toBeVisible()
  expect(api.handoffUsed.has("a")).toBe(true)
  await page.getByRole("link", { name: "Continue to payment" }).click()
  await page.getByRole("link", { name: "Return to call" }).click()
  await expect(
    page.getByRole("heading", { name: "Getting the call ready" })
  ).toBeVisible()
  await expect(page).toHaveURL("/call/a")
})

for (const scenario of [
  "expired",
  "revoked",
  "wrong-call",
  "legacy",
] as const) {
  test(`Checkout handoff fails closed for ${scenario}`, async ({
    page,
    api,
  }) => {
    api.handoffExpired = scenario === "expired"
    api.revoked = scenario === "revoked"
    api.legacyCheckout = scenario === "legacy"
    if (scenario === "wrong-call") {
      await page.goto(`/call/b#handoff=${handoffs.a}`)
    } else {
      await page.goto("/checkout")
      await page.getByRole("link", { name: "Return to call" }).click()
    }
    await expect(
      page.getByRole("status", { name: "Call unavailable" })
    ).toBeVisible()
    await expect(page.getByText(/Private task for/)).toHaveCount(0)
    await expect(page).toHaveURL(
      scenario === "wrong-call" ? "/call/b" : "/call/a"
    )
  })
}

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
  await expect(page.getByRole("region", { name: "Recording" })).toBeVisible()
  await expect(page.getByText("Transcript for a")).toBeVisible()
  const audio = page.locator("audio")
  await expect
    .poll(() => audio.evaluate((el: HTMLAudioElement) => el.duration))
    .toBe(recordingSeconds)
  await page
    .getByRole("button", { name: "Play recording", exact: true })
    .click()
  await expect(
    page.getByRole("button", { name: "Pause recording" })
  ).toBeVisible()
  await page.getByRole("button", { name: "Pause recording" }).click()
  await expect
    .poll(() => audio.evaluate((el: HTMLAudioElement) => el.paused))
    .toBe(true)
  await page.getByRole("button", { name: "Playback speed" }).click()
  await page.getByRole("menuitemradio", { name: "1.5×", exact: true }).click()
  expect(await audio.evaluate((el: HTMLAudioElement) => el.playbackRate)).toBe(
    1.5
  )
  const position = page.getByRole("slider", { name: "Recording position" })
  await position.focus()
  await position.press("Home")
  await position.press("ArrowRight")
  await expect
    .poll(() => audio.evaluate((el: HTMLAudioElement) => el.currentTime))
    .toBeCloseTo(0.1)
  await page.getByRole("button", { name: "Forward 10 seconds" }).click()
  await expect
    .poll(() => audio.evaluate((el: HTMLAudioElement) => el.currentTime))
    .toBe(recordingSeconds)
  await page.getByRole("button", { name: "Back 10 seconds" }).click()
  await expect
    .poll(() => audio.evaluate((el: HTMLAudioElement) => el.currentTime))
    .toBe(0)
  await page
    .getByText("Yes, the appointment is confirmed.", { exact: true })
    .click()
  await expect
    .poll(() => audio.evaluate((el: HTMLAudioElement) => el.currentTime))
    .toBe(2)
  await expect(page.locator('li[aria-current="time"]')).toContainText(
    "Yes, the appointment is confirmed."
  )
  expect(await audio.evaluate((el: HTMLAudioElement) => el.paused)).toBe(true)
  const firstTurn = page.getByRole("button", { name: /^Seek to 0:00:/ })
  await firstTurn.focus()
  await firstTurn.press("Enter")
  await expect
    .poll(() => audio.evaluate((el: HTMLAudioElement) => el.currentTime))
    .toBe(0)
  const secondTurn = page.getByRole("button", { name: /^Seek to 0:02:/ })
  await secondTurn.focus()
  await secondTurn.press("Space")
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
  await expect(secondTurn).toBeVisible()
  await page
    .getByText("Yes, the appointment is confirmed.", { exact: true })
    .click()
  await expect
    .poll(() => audio.evaluate((el: HTMLAudioElement) => el.currentTime))
    .toBe(2)
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth
    )
  ).toBe(true)
})

test("recording highlighting follows speech spans through overlap and silence", async ({
  page,
  api,
}) => {
  api.stage = "ended"
  api.turns = [
    {
      room: "room-a",
      seq: 1,
      role: "user",
      text: "Hello?",
      at: 1800,
      started_at: 1200,
      ended_at: 1600,
    },
    {
      room: "room-a",
      seq: 2,
      role: "agent",
      text: "How can I help?",
      at: 2100,
      started_at: 2000,
      ended_at: 3600,
    },
    {
      room: "room-a",
      seq: 3,
      role: "user",
      text: "One moment.",
      at: 2900,
      started_at: 2400,
      ended_at: 2700,
    },
  ]
  await page.goto(`/call/a#token=${tokens.a}`)
  const audio = page.locator("audio")
  const current = page.locator('li[aria-current="time"]')
  await expect
    .poll(() => audio.evaluate((el: HTMLAudioElement) => el.duration))
    .toBe(recordingSeconds)

  for (const [text, seconds] of [
    ["Hello?", 0.2],
    ["How can I help?", 1],
    ["One moment.", 1.4],
  ] as const) {
    await page.getByText(text, { exact: true }).click()
    await expect
      .poll(() => audio.evaluate((el: HTMLAudioElement) => el.currentTime))
      .toBeCloseTo(seconds)
    await expect(current).toContainText(text)
  }

  const scrub = (seconds: number) =>
    audio.evaluate((el: HTMLAudioElement, position) => {
      el.currentTime = position
      el.dispatchEvent(new Event("timeupdate"))
    }, seconds)
  await scrub(1.7)
  await expect(current).toContainText("How can I help?")
  await scrub(2.6)
  await expect(current).toHaveCount(0)
  await scrub(0.6)
  await expect(current).toHaveCount(0)
})

test("reading earlier messages pauses following without stopping live updates", async ({
  page,
  api,
}) => {
  api.stage = "active"
  api.turns = Array.from({ length: 20 }, (_, index) => ({
    room: "room-a",
    seq: index + 1,
    role: "agent" as const,
    text: `Message ${index + 1}: checking the appointment details.`,
    at: 1000 + index * 1000,
  }))
  await page.clock.install()
  await page.goto(`/call/a#token=${tokens.a}`)
  const transcript = page.getByRole("region", { name: "Call transcript" })
  const distanceFromBottom = () =>
    transcript.evaluate(
      (el) => el.scrollHeight - el.scrollTop - el.clientHeight
    )
  await expect.poll(distanceFromBottom).toBeLessThan(2)
  await transcript.evaluate((el) => {
    el.scrollTop = 0
  })
  await expect(
    page.getByRole("button", { name: "Jump to latest" })
  ).toBeVisible()
  const pagePosition = await page.evaluate(() => window.scrollY)
  api.turns = [
    ...api.turns,
    {
      room: "room-a",
      seq: 21,
      role: "user",
      text: "The appointment is confirmed.",
      at: 22000,
    },
  ]
  await page.clock.runFor(15_001)
  await expect(transcript.locator("li")).toHaveCount(21)
  expect(await transcript.evaluate((el) => el.scrollTop)).toBe(0)
  expect(await page.evaluate(() => window.scrollY)).toBe(pagePosition)
  await page.getByRole("button", { name: "Jump to latest" }).click()
  await expect.poll(distanceFromBottom).toBeLessThan(2)
  await expect(
    page.getByRole("button", { name: "Jump to latest" })
  ).toHaveCount(0)
})

test("the transcript can be copied with speakers and recording timestamps", async ({
  page,
  context,
  api,
}) => {
  api.stage = "ended"
  await context.grantPermissions(["clipboard-read", "clipboard-write"])
  await page.goto(`/call/a#token=${tokens.a}`)
  await page.getByRole("button", { name: "Copy transcript" }).click()
  await expect(
    page.getByRole("status", { name: "Transcript copy status" })
  ).toHaveText("Transcript copied")
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    "0:00 Assistant\nTranscript for a\n\n0:02 Recipient\nYes, the appointment is confirmed."
  )
})

test("the theme menu persists preferences and follows the system and shortcut", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" })
  await page.goto(`/call/a#token=${tokens.a}`)
  await expect(
    page.getByRole("heading", { name: "+1 (555) 123-4567" })
  ).toBeVisible()
  await expect(page.locator("main")).toHaveCSS(
    "background-color",
    "rgb(20, 20, 20)"
  )
  await page.getByRole("button", { name: "Change theme" }).click()
  await page.getByRole("menuitemradio", { name: "Light", exact: true }).click()
  await expect(page.locator("main")).toHaveCSS(
    "background-color",
    "rgb(252, 252, 252)"
  )
  await page.reload()
  await expect(page.locator("main")).toHaveCSS(
    "background-color",
    "rgb(252, 252, 252)"
  )
  await page.getByRole("button", { name: "Change theme" }).click()
  await page.getByRole("menuitemradio", { name: "System", exact: true }).click()
  await expect(page.locator("main")).toHaveCSS(
    "background-color",
    "rgb(20, 20, 20)"
  )
  await page.emulateMedia({ colorScheme: "light" })
  await expect(page.locator("main")).toHaveCSS(
    "background-color",
    "rgb(252, 252, 252)"
  )
  await page.getByRole("button", { name: "Change theme" }).click()
  await page.getByRole("menuitemradio", { name: "Dark", exact: true }).click()
  await expect(page.locator("main")).toHaveCSS(
    "background-color",
    "rgb(20, 20, 20)"
  )
  await page.keyboard.press("d")
  await expect(page.locator("main")).toHaveCSS(
    "background-color",
    "rgb(252, 252, 252)"
  )
  // The public website still follows the system, independent of the app shortcut.
  await page.emulateMedia({ colorScheme: "dark" })
  await page.goto("/documentation")
  await expect(page.locator("[data-website]")).toHaveCSS(
    "background-color",
    "rgb(20, 20, 20)"
  )
})

for (const [stage, heading] of [
  ["dialing", "Waiting for an answer"],
  ["failed", "The call couldn’t be placed"],
] as const) {
  test(`${stage} calls show a clear status without offering payment`, async ({
    page,
    api,
  }) => {
    api.stage = stage
    await page.goto(`/call/a#token=${tokens.a}`)
    await expect(page.getByRole("heading", { name: heading })).toBeVisible()
    await expect(
      page.getByRole("link", { name: "Continue to payment" })
    ).toHaveCount(0)
    await expect(page.getByText("Private task for a")).toBeVisible()
  })
}
