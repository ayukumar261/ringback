"use client"

import { use, useCallback, useEffect, useRef, useState } from "react"
import { LoaderCircle, LockKeyhole } from "lucide-react"
import { SWRConfig } from "swr"
import { useCall } from "@/hooks/use-call"
import { API_URL, audioUrl, callKey } from "@/lib/api/config"
import type { Turn } from "@/lib/api/types"
import { cn } from "@/lib/utils"

const fmtTime = (ms?: number) =>
  ms === undefined ? undefined : new Date(ms).toLocaleString()

const fmtOffset = (ms: number) => {
  const s = Math.floor(Math.abs(ms) / 1000)
  return `${ms < 0 ? "−" : ""}${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`
}

const turnStart = (turn: Turn) => turn.started_at ?? turn.at

export default function CallPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = use(params)
  // Reset access and playback state when navigating between calls.
  return <CallDashboard key={id} id={id} />
}

function CallPlaceholder({ loading = false }: { loading?: boolean }) {
  const Icon = loading ? LoaderCircle : LockKeyhole
  return (
    <div
      role="status"
      aria-label={loading ? "Loading call" : "Call unavailable"}
      className="fixed inset-0 grid place-items-center text-muted-foreground"
    >
      <Icon
        aria-hidden="true"
        className={cn(
          "size-5",
          loading && "animate-spin motion-reduce:animate-none"
        )}
      />
    </div>
  )
}

// Trades the link's token for a call-scoped cookie. Without a token, an
// existing HttpOnly cookie may already authorize this visit.
async function requestAccess(id: string, token: string | null) {
  if (!token) return true
  try {
    const response = await fetch(`${API_URL}${callKey(id)}/access`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      credentials: "same-origin",
      cache: "no-store",
    })
    return response.ok
  } catch {
    return false
  }
}

function CallDashboard({ id }: { id: string }) {
  const [access, setAccess] = useState<"loading" | "ready" | "unavailable">(
    "loading"
  )
  const pending = useRef<Promise<boolean> | null>(null)
  const loseAccess = useCallback(() => setAccess("unavailable"), [])

  useEffect(() => {
    let active = true
    const initialize = () => {
      const fragment = window.location.hash
      if (fragment) {
        window.history.replaceState(
          window.history.state,
          "",
          window.location.pathname + window.location.search
        )
        pending.current = null
      }
      // Share initialization across React's development effect replay.
      pending.current ??= requestAccess(
        id,
        new URLSearchParams(fragment.slice(1)).get("token")
      )
      pending.current.then((ok) => {
        if (active) setAccess(ok ? "ready" : "unavailable")
      })
    }
    initialize()
    window.addEventListener("hashchange", initialize)
    return () => {
      active = false
      window.removeEventListener("hashchange", initialize)
    }
  }, [id])

  return (
    <main className="flex min-h-svh flex-col gap-4 p-6 font-mono text-xs/relaxed">
      {access === "ready" ? (
        <SWRConfig value={{ provider: () => new Map() }}>
          <CallContent id={id} onAccessLost={loseAccess} />
        </SWRConfig>
      ) : (
        <CallPlaceholder loading={access === "loading"} />
      )}
    </main>
  )
}

function CallContent({
  id,
  onAccessLost,
}: {
  id: string
  onAccessLost: () => void
}) {
  const { call, turns, connected, denied } = useCall(id, onAccessLost)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState<number>()
  const [audioError, setAudioError] = useState(false)
  const audio = useRef<HTMLAudioElement>(null)
  if (denied) return <CallPlaceholder />
  const data = call.data
  if (!data) return <CallPlaceholder loading={!call.error} />

  const live = data.call?.status === "active"
  const audioStartedAt =
    data.call?.audio_started_at ??
    (data.call?.ended_at !== undefined && duration !== undefined
      ? data.call.ended_at - duration * 1000
      : undefined)
  const seek = (seconds: number) => {
    if (!audio.current || duration === undefined) return
    audio.current.currentTime = Math.max(0, Math.min(seconds, duration))
    setCurrentTime(audio.current.currentTime)
    audio.current.focus()
  }
  const details = {
    call_id: data.call_id,
    status: data.status,
    to: data.to,
    amount: data.amount,
    currency: data.currency,
    max_duration_seconds: data.max_duration_seconds,
    created_at: data.created_at,
    checkout_expires_at: data.checkout_expires_at,
    access_expires_at: data.access_expires_at,
    call: data.call
      ? {
          status: data.call.status,
          started: fmtTime(data.call.started_at),
          ended: fmtTime(data.call.ended_at),
          duration_ms: data.call.duration_ms,
          audio_available: data.call.audio_available,
        }
      : null,
  }
  return (
    <>
      <pre
        aria-label="Call details"
        className="wrap-anywhere whitespace-pre-wrap"
      >
        {JSON.stringify(details, null, 2)}
      </pre>
      {call.error && (
        <p role="status" className="text-muted-foreground">
          updates unavailable; reconnecting…
        </p>
      )}
      {data.checkout_url && (
        <a href={data.checkout_url} className="self-start underline">
          Continue to payment
        </a>
      )}
      <section className="flex flex-col gap-4">
        <h2 className="text-muted-foreground">prompt</h2>
        <pre className="wrap-anywhere whitespace-pre-wrap">{data.prompt}</pre>
      </section>
      {data.call?.audio_available && (
        <section className="flex flex-col gap-4">
          <h2 className="text-muted-foreground">audio</h2>
          <audio
            ref={audio}
            controls
            preload="metadata"
            src={audioUrl(id)}
            className="w-full max-w-xl"
            aria-label="Call recording"
            onTimeUpdate={(event) =>
              setCurrentTime(event.currentTarget.currentTime)
            }
            onDurationChange={(event) => {
              const value = event.currentTarget.duration
              setDuration(Number.isFinite(value) ? value : undefined)
            }}
            onError={() => {
              setAudioError(true)
              void call.mutate().catch(() => {})
            }}
          />
          {audioError && (
            <p role="alert" className="text-destructive">
              audio unavailable;{" "}
              <button
                className="underline"
                onClick={() => {
                  setAudioError(false)
                  audio.current?.load()
                }}
              >
                retry
              </button>
            </p>
          )}
        </section>
      )}
      <Transcript
        turns={turns.data}
        error={turns.error}
        isLoading={turns.isLoading}
        live={live}
        currentTime={currentTime}
        audioStartedAt={audioStartedAt}
        onSeek={
          data.call?.audio_available && duration !== undefined
            ? seek
            : undefined
        }
      />
      {data.call?.status !== "ended" && (
        <p className="text-muted-foreground">
          {connected ? "live updates connected" : "live updates reconnecting…"}
        </p>
      )}
    </>
  )
}

// Transcript follows the recording's playhead, or the newest turn during a live call.
function Transcript({
  turns,
  error,
  isLoading,
  live,
  currentTime,
  audioStartedAt,
  onSeek,
}: {
  turns?: Turn[]
  error?: Error
  isLoading: boolean
  live: boolean
  currentTime: number
  audioStartedAt?: number
  onSeek?: (seconds: number) => void
}) {
  const currentRef = useRef<HTMLLIElement>(null)
  let current: Turn | undefined
  if (live) {
    current = turns?.at(-1)
  } else if (audioStartedAt !== undefined) {
    const instant = audioStartedAt + currentTime * 1000
    for (const turn of turns ?? []) {
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
  }, [current?.seq, current?.text])

  return (
    <section className="flex flex-col gap-4">
      <h2 className="text-muted-foreground">transcript</h2>
      {error ? (
        <p role="alert" className="text-destructive">
          transcript unavailable
        </p>
      ) : isLoading ? (
        <p className="text-muted-foreground">loading…</p>
      ) : !turns?.length ? (
        <p className="text-muted-foreground">no turns yet</p>
      ) : (
        <ol>
          {turns.map((turn, index) => {
            const offset =
              audioStartedAt === undefined
                ? undefined
                : turnStart(turn) - audioStartedAt
            const previousEnd = turns[index - 1]?.ended_at
            const overlap =
              turn.started_at !== undefined && previousEnd !== undefined
                ? previousEnd - turn.started_at
                : 0
            const isCurrent = turn.seq === current?.seq
            const seekTo =
              onSeek && offset !== undefined
                ? () => onSeek(offset / 1000)
                : undefined

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
                  disabled={!seekTo}
                  onClick={seekTo}
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
