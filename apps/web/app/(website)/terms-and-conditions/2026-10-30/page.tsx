import type { Metadata } from "next"

import TermsAndConditions from "@/content/terms-and-conditions/2026-10-30.mdx"

export const metadata: Metadata = {
  title: "Terms and Conditions — October 30, 2026 | Corbyn AI",
  description:
    "The October 30, 2026 edition of the Corbyn AI Terms and Conditions.",
  alternates: {
    canonical: "https://corbyn.ai/terms-and-conditions/2026-10-30",
  },
}

export default function Page() {
  return (
    <article>
      <TermsAndConditions />
    </article>
  )
}
