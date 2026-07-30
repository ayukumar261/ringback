"use client"

import { useCalls } from "@/hooks/use-calls"
import { useCallsStream } from "@/hooks/use-calls-stream"

// Raw view of the SWR data layer until the real dashboard lands.
function Snapshot() {
  const { data, error, isLoading } = useCalls()
  useCallsStream()
  return (
    <section>
      <pre className="text-xs">
        {JSON.stringify({ isLoading, error: error?.message, data }, null, 2)}
      </pre>
    </section>
  )
}

export default function Page() {
  return (
    <main className="flex min-h-svh flex-col gap-4 p-6 font-mono">
      <Snapshot />
    </main>
  )
}
