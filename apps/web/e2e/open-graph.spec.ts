import { expect, test } from "@playwright/test"

// Link unfurlers read the server HTML without running scripts.
test.use({ javaScriptEnabled: false })

const paths = [
  "/",
  "/documentation",
  "/terms-and-conditions",
  "/terms-and-conditions/2026-10-30",
  "/privacy-policy",
  "/privacy-policy/2026-10-30",
  "/call/3f2a9c1e-7b4d-4e8a-9c2f-1a2b3c4d5e6f",
]

for (const path of paths) {
  test(`${path} previews a 1200×630 image`, async ({ page, request }) => {
    await page.goto(path)
    const meta = (key: string) =>
      page
        .locator(`meta[property="${key}"], meta[name="${key}"]`)
        .getAttribute("content")
    const image = new URL((await meta("og:image")) ?? "")
    expect(image.origin).toBe("https://corbyn.ai")
    expect(await meta("og:title")).toBe(await page.title())
    expect(await meta("og:description")).toBe(await meta("description"))
    expect(await meta("twitter:card")).toBe("summary_large_image")
    const response = await request.get(image.pathname + image.search)
    expect(response.status()).toBe(200)
    expect(response.headers()["content-type"]).toBe("image/png")
    const png = await response.body()
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([1200, 630])
  })
}

test("call pages are named by a call ID and nothing else in the URL", async ({
  page,
}) => {
  await page.goto("/call/3f2a9c1e-7b4d-4e8a-9c2f-1a2b3c4d5e6f")
  await expect(page).toHaveTitle("Call 3f2a9c1e — Corbyn AI")
  await page.goto("/call/Free money here")
  await expect(page).toHaveTitle("Call — Corbyn AI")
})
