import type { Metadata } from "next"

import TermsAndConditions from "@/content/terms-and-conditions/2026-10-30.mdx"

export const metadata: Metadata = {
  title: "Terms and Conditions | Corbyn AI",
  description:
    "Terms for using Corbyn AI, including calling permissions, pricing, refunds, and access to call results.",
  alternates: {
    canonical: "https://corbyn.ai/terms-and-conditions",
  },
}

export default function Page() {
  return (
    <article>
      <TermsAndConditions />
    </article>
  )
}
