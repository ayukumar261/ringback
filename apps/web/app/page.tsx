"use client"

import { useState } from "react"

import { useCalls } from "@/hooks/use-calls"
import { useCallsStream } from "@/hooks/use-calls-stream"
import { useTurns } from "@/hooks/use-turns"
import type { Call } from "@/lib/api/types"
import { cn } from "@/lib/utils"

// fmtTime renders unix ms as a local date-time.
const fmtTime = (ms?: number) =>
  ms === undefined ? undefined : new Date(ms).toLocaleString()

// fmtDuration renders ms as "3m 07s".
const fmtDuration = (ms?: number) => {
  if (ms === undefined) return undefined
  const s = Math.round(ms / 1000)
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`
}

// StatusDot marks a call live (pulsing) or ended.
function StatusDot({ status }: { status: Call["status"] }) {
  return (
    <span
      aria-hidden
      className={cn(
        "size-1.5 shrink-0 rounded-full",
        status === "active"
          ? "animate-pulse bg-emerald-500"
          : "bg-current opacity-40"
      )}
    />
  )
}

// CallPicker is the conversation selector at the top of the page.
function CallPicker({
  calls,
  selected,
  onSelect,
}: {
  calls: Call[]
  selected: string | null
  onSelect: (room: string) => void
}) {
  return (
    <nav className="flex flex-wrap gap-x-4 gap-y-1">
      {calls.map((call) => (
        <button
          key={call.room}
          className={cn(
            "flex items-center gap-1.5 hover:underline",
            call.room === selected && "underline"
          )}
          onClick={() => onSelect(call.room)}
        >
          <StatusDot status={call.status} />
          {call.room}
        </button>
      ))}
    </nav>
  )
}

// CallDetails shows the selected call's metadata as one small JSON object.
function CallDetails({ call }: { call: Call }) {
  const display = {
    room: call.room,
    status: call.status,
    from: call.from || undefined,
    to: call.to || undefined,
    started: fmtTime(call.started_at),
    ended: fmtTime(call.ended_at),
    duration: fmtDuration(call.duration_ms),
    conversation_id: call.conversation_id || undefined,
  }
  return <pre>{JSON.stringify(display, null, 2)}</pre>
}

// Transcript shows the selected call's turns as one JSON array, kept live by useCallsStream.
function Transcript({ room }: { room: string }) {
  const { data, error, isLoading } = useTurns(room)
  const display = data?.map((turn) => ({
    seq: turn.seq,
    role: turn.role,
    text: turn.text,
    at: fmtTime(turn.at),
  }))
  return (
    <section className="flex flex-col gap-1">
      <h2 className="text-muted-foreground">transcript</h2>
      {error ? (
        <p className="text-destructive">transcript failed: {error.message}</p>
      ) : isLoading ? (
        <p className="text-muted-foreground">loading…</p>
      ) : !display?.length ? (
        <p className="text-muted-foreground">no turns yet</p>
      ) : (
        <pre className="whitespace-pre-wrap">
          {JSON.stringify(display, null, 2)}
        </pre>
      )}
    </section>
  )
}

export default function Page() {
  const { data: calls, error, isLoading } = useCalls()
  useCallsStream()
  const [room, setRoom] = useState<string | null>(null)
  const selected = calls?.find((call) => call.room === room)

  return (
    <main className="flex min-h-svh flex-col gap-4 p-6 font-mono text-xs/relaxed">
      <header className="text-muted-foreground">
        ringback
        {calls !== undefined &&
          ` — ${calls.length} call${calls.length === 1 ? "" : "s"}`}
      </header>
      {error ? (
        <p className="text-destructive">calls failed: {error.message}</p>
      ) : isLoading ? (
        <p className="text-muted-foreground">loading calls…</p>
      ) : !calls?.length ? (
        <p className="text-muted-foreground">
          no calls yet — new calls appear here live
        </p>
      ) : (
        <>
          <CallPicker
            calls={calls}
            selected={room}
            onSelect={(next) => setRoom((r) => (r === next ? null : next))}
          />
          {selected !== undefined ? (
            <>
              <CallDetails call={selected} />
              <Transcript room={selected.room} />
            </>
          ) : (
            <p className="text-muted-foreground">select a call</p>
          )}
        </>
      )}
    </main>
  )
}
