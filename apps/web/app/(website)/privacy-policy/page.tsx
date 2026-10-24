import type { Metadata } from "next"

import PrivacyPolicy from "@/content/privacy-policy/2026-10-30.mdx"

export const metadata: Metadata = {
  title: "Privacy Policy | Corbyn AI",
  description:
    "How Corbyn AI handles call recordings, transcripts, payments, access credentials, and privacy requests.",
  alternates: {
    canonical: "https://corbyn.ai/privacy-policy",
  },
}

export default function Page() {
  return (
    <article>
      <PrivacyPolicy />
    </article>
  )
}
