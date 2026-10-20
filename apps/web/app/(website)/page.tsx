import type { Metadata } from "next"

import Introduction from "@/content/introduction.mdx"

export const metadata: Metadata = {
  title: "Corbyn AI",
  description:
    "Corbyn AI makes phone calls for AI agents. One API request creates the call, Stripe Checkout takes payment, and the transcript is ready when the call ends.",
}

export default function Page() {
  return (
    <article>
      <Introduction />
    </article>
  )
}
