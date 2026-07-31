"use client"

import { useState } from "react"

import { useCalls } from "@/hooks/use-calls"
import { useCallsStream } from "@/hooks/use-calls-stream"
import { useTurns } from "@/hooks/use-turns"

// Raw view of one call's transcript, live like the call list.
function Transcript({ room }: { room: string }) {
  const { data, error, isLoading } = useTurns(room)
  return (
    <pre className="text-xs">
      {JSON.stringify({ room, isLoading, error: error?.message, data }, null, 2)}
    </pre>
  )
}

// Raw view of the SWR data layer until the real dashboard lands.
function Snapshot() {
  const { data, error, isLoading } = useCalls()
  useCallsStream()
  const [room, setRoom] = useState<string | null>(null)
  return (
    <section className="flex flex-col gap-4">
      <pre className="text-xs">
        {JSON.stringify({ isLoading, error: error?.message, data }, null, 2)}
      </pre>
      <nav className="flex flex-wrap gap-2 text-xs">
        {data?.map((call) => (
          <button
            key={call.room}
            className={call.room === room ? "underline" : ""}
            onClick={() => setRoom((r) => (r === call.room ? null : call.room))}
          >
            {call.room}
          </button>
        ))}
      </nav>
      {room !== null && <Transcript room={room} />}
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
