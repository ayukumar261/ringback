import type { Metadata } from "next"

import PrivacyPolicy from "@/content/privacy-policy/2026-10-30.mdx"

export const metadata: Metadata = {
  title: "Privacy Policy — October 30, 2026 | Corbyn AI",
  description: "The October 30, 2026 edition of the Corbyn AI Privacy Policy.",
  alternates: {
    canonical: "https://corbyn.ai/privacy-policy/2026-10-30",
  },
}

export default function Page() {
  return (
    <article>
      <PrivacyPolicy />
    </article>
  )
}
