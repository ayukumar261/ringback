import type { Metadata } from "next"
import type { ReactNode } from "react"

export const dynamic = "force-dynamic"

// Metadata stays on the server while the page handles browser-only access.
export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>
}): Promise<Metadata> {
  const { id } = await params
  const title = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id)
    ? `Call ${id.slice(0, 8)}`
    : "Call"
  return {
    title: `${title} — Corbyn AI`,
    description: "Call details and transcript.",
    robots: { index: false, follow: false, noarchive: true },
    referrer: "no-referrer",
  }
}

export default function CallLayout({ children }: { children: ReactNode }) {
  return children
}
