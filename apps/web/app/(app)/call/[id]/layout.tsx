import type { Metadata } from "next"
import type { ReactNode } from "react"

export const dynamic = "force-dynamic"

// Metadata stays on the server while the page handles browser-only access.
export const metadata: Metadata = {
  title: "Private call · Ringback",
  description: "Your private call dashboard.",
  robots: { index: false, follow: false, noarchive: true },
  referrer: "no-referrer",
}

export default function CallLayout({ children }: { children: ReactNode }) {
  return children
}
