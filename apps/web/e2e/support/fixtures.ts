import { expect, test as base } from "@playwright/test"
import { mockApi, type MockApi } from "./mock-api"

export const test = base.extend<{ api: MockApi }>({
  // An uncaught browser error in any of the test's tabs fails the test.
  context: async ({ context }, use) => {
    const errors: string[] = []
    context.on("weberror", (error) => errors.push(error.error().message))
    await use(context)
    expect(errors).toEqual([])
  },
  // Every test talks to the mocked API, whether or not it inspects it.
  api: [
    async ({ context }, use) => use(await mockApi(context)),
    { auto: true },
  ],
})

export { expect }
