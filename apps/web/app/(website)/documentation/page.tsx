import type { Metadata } from "next"

import { Contents, type Section } from "@/components/ui/contents"
import Documentation from "@/content/documentation.mdx"

export const metadata: Metadata = {
  title: "Corbyn AI — Documentation",
  description:
    "Every Corbyn AI endpoint: create a call, pay through Stripe Checkout, check its status, stream live events, and read the transcript and recording.",
}

// Each id is the slug of a `##` heading in documentation.mdx.
const sections: readonly Section[] = [
  { id: "authentication", title: "Authentication" },
  { id: "create-a-call", title: "Create a call" },
  { id: "get-a-call", title: "Get a call" },
  { id: "call-status", title: "Call status" },
  { id: "payment-status", title: "Payment status" },
  { id: "get-the-transcript", title: "Get the transcript" },
  { id: "stream-live-events", title: "Stream live events" },
  { id: "get-the-recording", title: "Get the recording" },
  { id: "retry-safely", title: "Retry safely" },
  { id: "errors", title: "Errors" },
  { id: "limits", title: "Limits" },
  { id: "health-check", title: "Health check" },
]

export default function Page() {
  return (
    // relative anchors the table of contents in the left margin on wide screens.
    <article className="relative">
      <Documentation
        components={{ Contents: () => <Contents sections={sections} /> }}
      />
    </article>
  )
}
