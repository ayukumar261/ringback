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
