import { expect, test } from "@playwright/test"

test("Documentation contents link to every section in order", async ({
  page,
}) => {
  await page.goto("/documentation")
  const links = await page
    .getByRole("navigation", { name: "On this page" })
    .getByRole("link")
    .evaluateAll((anchors) => anchors.map((a) => a.getAttribute("href")))
  const sections = await page
    .locator("article h2")
    .evaluateAll((headings) => headings.map((h) => `#${h.id}`))
  expect(links).toEqual(sections)
})

test("Checkout's dated Terms URL preserves the published edition", async ({
  page,
}) => {
  await page.goto("/terms-and-conditions")
  const current = await page.locator("article").innerText()
  await page.goto("/terms-and-conditions/2026-10-30")
  await expect(
    page.getByRole("heading", {
      name: "Corbyn AI Terms and Conditions",
      exact: true,
    })
  ).toBeVisible()
  expect(await page.locator("article").innerText()).toBe(current)
  await expect(page.locator("article")).toContainText(
    "Effective date: October 30, 2026"
  )
})
