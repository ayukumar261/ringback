"use client"

import { useEffect, useRef, useState, type RefObject } from "react"

import { useCalls } from "@/hooks/use-calls"
import { useCallsStream } from "@/hooks/use-calls-stream"
import { useTurns } from "@/hooks/use-turns"
import { audioUrl } from "@/lib/api/config"
import type { Call, Turn } from "@/lib/api/types"
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

// fmtOffset renders a position in the recording as m:ss.
const fmtOffset = (ms: number) => {
  const s = Math.floor(Math.abs(ms) / 1000)
  return `${ms < 0 ? "−" : ""}${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`
}

const turnStart = (turn: Turn) => turn.started_at ?? turn.at

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
    direction: call.direction || undefined,
    started: fmtTime(call.started_at),
    ended: fmtTime(call.ended_at),
    duration: fmtDuration(call.duration_ms),
    conversation_id: call.conversation_id || undefined,
  }
  return <pre>{JSON.stringify(display, null, 2)}</pre>
}

// Prompt shows what the calling agent asked for, and nothing on inbound calls.
function Prompt({ prompt }: { prompt?: string }) {
  if (!prompt) return null
  return (
    <section className="flex flex-col gap-4">
      <h2 className="text-muted-foreground">prompt</h2>
      <pre className="whitespace-pre-wrap">{prompt}</pre>
    </section>
  )
}

// Player plays the call's recording, and nothing while the call is live or recording was off.
function Player({
  call,
  audioRef,
  onTimeUpdate,
  onDurationChange,
}: {
  call: Call
  audioRef: RefObject<HTMLAudioElement | null>
  onTimeUpdate: (seconds: number) => void
  onDurationChange: (seconds: number | undefined) => void
}) {
  if (call.status === "active" || !call.audio) return null
  return (
    <section className="flex flex-col gap-4">
      <h2 className="text-muted-foreground">audio</h2>
      <audio
        key={call.room}
        ref={audioRef}
        controls
        preload="metadata"
        src={audioUrl(call.room)}
        onTimeUpdate={(event) => onTimeUpdate(event.currentTarget.currentTime)}
        onLoadedMetadata={(event) => {
          const duration = event.currentTarget.duration
          onDurationChange(Number.isFinite(duration) ? duration : undefined)
        }}
        onDurationChange={(event) => {
          const duration = event.currentTarget.duration
          onDurationChange(Number.isFinite(duration) ? duration : undefined)
        }}
        className="w-full max-w-xl"
      />
    </section>
  )
}

// Transcript follows the recording's playhead, or the newest turn during a live call.
function Transcript({
  call,
  currentTime,
  audioStartedAt,
  onSeek,
}: {
  call: Call
  currentTime: number
  audioStartedAt?: number
  onSeek?: (seconds: number) => void
}) {
  const { data, error, isLoading } = useTurns(call.room)
  const currentRef = useRef<HTMLLIElement>(null)
  let current: Turn | undefined
  if (call.status === "active") {
    current = data?.at(-1)
  } else if (call.audio && audioStartedAt !== undefined) {
    const instant = audioStartedAt + currentTime * 1000
    for (const turn of data ?? []) {
      const start = turnStart(turn)
      if (
        start <= instant &&
        (current === undefined || start >= turnStart(current))
      ) {
        current = turn
      }
    }
  }

  useEffect(() => {
    currentRef.current?.scrollIntoView({ block: "nearest" })
  }, [call.room, current?.seq, current?.text])

  return (
    <section className="flex flex-col gap-4">
      <h2 className="text-muted-foreground">transcript</h2>
      {error ? (
        <p className="text-destructive">transcript failed: {error.message}</p>
      ) : isLoading ? (
        <p className="text-muted-foreground">loading…</p>
      ) : !data?.length ? (
        <p className="text-muted-foreground">no turns yet</p>
      ) : (
        <ol>
          {data.map((turn, index) => {
            const offset =
              audioStartedAt === undefined
                ? undefined
                : turnStart(turn) - audioStartedAt
            const previousEnd = data[index - 1]?.ended_at
            const overlap =
              turn.started_at !== undefined && previousEnd !== undefined
                ? Math.max(0, previousEnd - turn.started_at)
                : 0
            const isCurrent = turn.seq === current?.seq
            const canSeek = onSeek !== undefined && offset !== undefined

            return (
              <li
                key={turn.seq}
                ref={isCurrent ? currentRef : undefined}
                aria-current={isCurrent ? "time" : undefined}
                className={cn(
                  "border-l-2 border-transparent",
                  isCurrent && "border-primary bg-primary/10"
                )}
              >
                <button
                  type="button"
                  disabled={!canSeek}
                  onClick={() => {
                    if (canSeek) onSeek(offset / 1000)
                  }}
                  className="grid w-full grid-cols-[3.5rem_3rem_minmax(0,1fr)] items-baseline gap-x-3 px-2 py-1 text-left focus-visible:outline-2 focus-visible:outline-ring enabled:hover:bg-muted"
                >
                  <span className="text-muted-foreground tabular-nums">
                    {offset === undefined ? "—" : fmtOffset(offset)}
                  </span>
                  <span className="text-muted-foreground">{turn.role}</span>
                  <span className="wrap-anywhere whitespace-pre-wrap">
                    {turn.text}
                    {overlap > 0 && (
                      <span className="text-muted-foreground">
                        {" "}
                        (starts {Math.round(overlap)} ms before previous turn
                        ends)
                      </span>
                    )}
                  </span>
                </button>
              </li>
            )
          })}
        </ol>
      )}
    </section>
  )
}

export default function Page() {
  const { data: calls, error, isLoading } = useCalls()
  useCallsStream()
  const [room, setRoom] = useState<string | null>(null)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState<number>()
  const audioRef = useRef<HTMLAudioElement>(null)
  const selected = calls?.find((call) => call.room === room)
  const audioStartedAt =
    selected?.audio_started_at ??
    (selected?.ended_at !== undefined && duration !== undefined
      ? selected.ended_at - duration * 1000
      : undefined)

  const seek = (seconds: number) => {
    const audio = audioRef.current
    if (!audio || duration === undefined) return
    audio.currentTime = Math.max(0, Math.min(seconds, duration))
    setCurrentTime(audio.currentTime)
  }

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
            onSelect={(next) => {
              setRoom((r) => (r === next ? null : next))
              setCurrentTime(0)
              setDuration(undefined)
            }}
          />
          {selected !== undefined ? (
            <>
              <CallDetails call={selected} />
              <Prompt prompt={selected.prompt} />
              <Player
                call={selected}
                audioRef={audioRef}
                onTimeUpdate={setCurrentTime}
                onDurationChange={setDuration}
              />
              <Transcript
                call={selected}
                currentTime={currentTime}
                audioStartedAt={audioStartedAt}
                onSeek={
                  selected.status === "ended" &&
                  selected.audio &&
                  duration !== undefined
                    ? seek
                    : undefined
                }
              />
            </>
          ) : (
            <p className="text-muted-foreground">select a call</p>
          )}
        </>
      )}
    </main>
  )
}
