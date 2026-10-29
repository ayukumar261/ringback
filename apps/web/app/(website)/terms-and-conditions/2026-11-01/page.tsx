import type { Metadata } from "next"

import TermsAndConditions from "@/content/terms-and-conditions/2026-11-01.mdx"

export const metadata: Metadata = {
  title: "Terms and Conditions — November 1, 2026 | Corbyn AI",
  description:
    "The November 1, 2026 edition of the Corbyn AI Terms and Conditions.",
  alternates: {
    canonical: "https://corbyn.ai/terms-and-conditions/2026-11-01",
  },
}

export default function Page() {
  return (
    <article>
      <TermsAndConditions />
    </article>
  )
}
