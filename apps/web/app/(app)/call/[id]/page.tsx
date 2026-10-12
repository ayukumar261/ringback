"use client"

import {
  use,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react"
import { SWRConfig } from "swr"
import Link from "next/link"
import { useTheme } from "next-themes"
import {
  ArrowUpRight,
  Check,
  Clock3,
  Headphones,
  LoaderCircle,
  LockKeyhole,
  MessageSquare,
  Phone,
  PhoneCall,
  SunMoon,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { useCall } from "@/hooks/use-call"
import { API_URL, audioUrl, callKey } from "@/lib/api/config"
import { ApiError } from "@/lib/api/fetcher"
import type { Call, Turn } from "@/lib/api/types"
import { cn } from "@/lib/utils"

export default function CallPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = use(params)
  // Reset access and playback state when navigating between calls.
  return <CallDashboard key={id} id={id} />
}

type AccessState = "checking" | "ready" | "locked" | "error"

function Shell({ children }: { children: ReactNode }) {
  const { resolvedTheme, setTheme } = useTheme()
  return (
    <main className="min-h-svh bg-muted/20">
      <header className="border-b bg-background">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-5 sm:px-8">
          <Link
            href="/"
            className="flex items-center gap-2.5 font-semibold tracking-tight"
          >
            <span className="rounded-lg bg-primary p-1.5 text-primary-foreground">
              <PhoneCall className="size-4" />
            </span>
            ringback
          </Link>
          <div className="flex items-center gap-4">
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <LockKeyhole className="size-3.5" /> Private call
            </span>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Toggle color theme"
              onClick={() =>
                setTheme(resolvedTheme === "dark" ? "light" : "dark")
              }
            >
              <SunMoon />
            </Button>
          </div>
        </div>
      </header>
      <div className="mx-auto max-w-6xl px-5 py-10 sm:px-8 sm:py-14">
        {children}
      </div>
    </main>
  )
}

function Unavailable({
  checking = false,
  error = false,
  onRetry,
}: {
  checking?: boolean
  error?: boolean
  onRetry?: () => void
}) {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-4 py-20 text-center">
      {checking ? (
        <LoaderCircle className="size-7 animate-spin text-primary" />
      ) : (
        <LockKeyhole className="size-8 text-muted-foreground" />
      )}
      <h1 className="text-2xl font-semibold tracking-tight">
        {checking
          ? "Opening your private call"
          : error
            ? "We couldn’t open this page"
            : "This call is locked or unavailable"}
      </h1>
      <p
        role="status"
        className="text-sm leading-relaxed text-muted-foreground"
      >
        {checking
          ? "Checking your access…"
          : error
            ? "Check your connection and try again."
            : "Open the original private link to view this call. The link may have expired or access may have been revoked."}
      </p>
      {onRetry && (
        <Button variant="outline" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  )
}

function CallDashboard({ id }: { id: string }) {
  const [access, setAccess] = useState<AccessState>("checking")
  const [attempt, setAttempt] = useState(0)
  const token = useRef<string | null>(null)
  const pending = useRef<Promise<void> | null>(null)
  const loseAccess = useCallback(() => setAccess("locked"), [])

  useEffect(() => {
    let active = true
    const initialize = () => {
      const fragment = window.location.hash
      if (fragment) {
        token.current = new URLSearchParams(fragment.slice(1)).get("token")
        window.history.replaceState(
          window.history.state,
          "",
          window.location.pathname + window.location.search
        )
        pending.current = null
      }
      // Share initialization across React's development effect replay.
      if (!pending.current) {
        const secret = token.current
        pending.current = (async () => {
          if (!secret) return // An existing HttpOnly cookie may authorize this visit.
          const response = await fetch(`${API_URL}${callKey(id)}/access`, {
            method: "POST",
            headers: { Authorization: `Bearer ${secret}` },
            credentials: "same-origin",
            cache: "no-store",
          })
          if (!response.ok) throw new ApiError(response.status, "call access")
          token.current = null
        })()
      }
      pending.current.then(
        () => {
          if (active) setAccess("ready")
        },
        (error: unknown) => {
          if (active)
            setAccess(
              error instanceof ApiError && [401, 404].includes(error.status)
                ? "locked"
                : "error"
            )
        }
      )
    }
    initialize()
    window.addEventListener("hashchange", initialize)
    return () => {
      active = false
      window.removeEventListener("hashchange", initialize)
    }
  }, [id, attempt])

  const retry = () => {
    pending.current = null
    setAccess("checking")
    setAttempt((value) => value + 1)
  }

  return (
    <Shell>
      {access === "ready" ? (
        <SWRConfig value={{ provider: () => new Map() }}>
          <CallContent id={id} onAccessLost={loseAccess} />
        </SWRConfig>
      ) : (
        <Unavailable
          checking={access === "checking"}
          error={access === "error"}
          onRetry={access === "checking" ? undefined : retry}
        />
      )}
    </Shell>
  )
}

function presentation(data: Call) {
  if (data.call?.status === "ended")
    return {
      title: "Call complete",
      description: "Your conversation is ready to revisit.",
      step: 3,
    }
  if (data.call?.status === "active")
    return {
      title: "Call in progress",
      description: "Follow the conversation as it happens.",
      step: 2,
    }
  if (data.status === "failed")
    return {
      title: "Call outcome unavailable",
      description:
        "We couldn’t confirm the call outcome. This request won’t be dialed again automatically.",
      step: 1,
    }
  if (
    data.status === "expired" ||
    (data.status === "unpaid" &&
      Date.parse(data.checkout_expires_at) <= Date.now())
  )
    return {
      title: "Payment window closed",
      description:
        "This checkout has expired. Ask your agent to create a new call request.",
      step: 0,
    }
  if (data.status === "unpaid")
    return {
      title: "Ready when you are",
      description: "Complete payment to let your agent place this call.",
      step: 0,
    }
  if (data.status === "paid")
    return {
      title: "Your call is queued",
      description: "Payment received. Your agent will dial shortly.",
      step: 1,
    }
  return {
    title:
      data.status === "dialing" ? "Connecting your call" : "Call dispatched",
    description: "Waiting for the conversation to begin.",
    step: 2,
  }
}

function CallContent({
  id,
  onAccessLost,
}: {
  id: string
  onAccessLost: () => void
}) {
  const { call, turns, connected } = useCall(id, onAccessLost)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState<number>()
  const [audioError, setAudioError] = useState(false)
  const audio = useRef<HTMLAudioElement>(null)
  const data = call.data
  if (
    (call.error instanceof ApiError &&
      [401, 404].includes(call.error.status)) ||
    (turns.error instanceof ApiError && [401, 404].includes(turns.error.status))
  )
    return <Unavailable />
  if (!data)
    return (
      <Unavailable
        checking={!call.error}
        error={!!call.error}
        onRetry={
          call.error
            ? () => {
                void call.mutate().catch(() => {})
              }
            : undefined
        }
      />
    )

  const state = presentation(data)
  const live = data.call?.status === "active"
  const price = new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: data.currency,
  }).format(data.amount / 100)
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
  return (
    <>
      <div className="mb-8 flex flex-wrap items-start justify-between gap-5">
        <div>
          <p className="mb-3 text-xs font-medium tracking-widest text-muted-foreground uppercase">
            Your call
          </p>
          <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
            {state.title}
          </h1>
          <p
            role="status"
            className="mt-3 max-w-xl text-sm leading-relaxed text-muted-foreground"
          >
            {state.description}
          </p>
        </div>
        {live && (
          <span className="flex items-center gap-2 rounded-full border border-emerald-500/20 bg-emerald-500/10 px-3 py-1.5 text-xs font-medium text-emerald-700 dark:text-emerald-400">
            <span className="size-1.5 animate-pulse rounded-full bg-current" />{" "}
            Live
          </span>
        )}
      </div>
      <ol aria-label="Call progress" className="mb-8 grid grid-cols-4 gap-2">
        {["Payment", "Queued", "Calling", "Finished"].map((label, index) => (
          <li
            key={label}
            aria-current={state.step === index ? "step" : undefined}
            className={cn(
              "border-t-2 pt-3 text-xs",
              state.step >= index
                ? "border-primary font-medium"
                : "border-border text-muted-foreground"
            )}
          >
            <span className="inline-flex items-center gap-1.5">
              {state.step > index && <Check className="size-3" />}
              {label}
            </span>
          </li>
        ))}
      </ol>
      {call.error && (
        <p role="status" className="mb-6 text-sm text-muted-foreground">
          Updates are temporarily unavailable. Reconnecting…
        </p>
      )}
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.8fr)]">
        <div className="space-y-6">
          <section className="rounded-2xl border bg-card p-6">
            <h2 className="mb-5 text-sm font-medium">Call details</h2>
            <div className="flex items-center gap-3">
              <span className="rounded-full bg-muted p-2.5">
                <Phone className="size-4 text-muted-foreground" />
              </span>
              <div>
                <p className="text-xs text-muted-foreground">Calling</p>
                <p className="mt-1 font-medium tabular-nums">{data.to}</p>
              </div>
            </div>
            <div className="my-6 border-t" />
            <h3 className="mb-2 text-xs font-medium text-muted-foreground">
              The task
            </h3>
            <p className="text-sm leading-relaxed wrap-anywhere whitespace-pre-wrap">
              {data.prompt}
            </p>
            <div className="mt-6 flex items-center justify-between gap-3 border-t pt-5 text-xs text-muted-foreground">
              <span>{price} per call</span>
              <span className="flex items-center gap-1">
                <Clock3 className="size-3" /> Up to{" "}
                {Math.round(data.max_duration_seconds / 60)} min
              </span>
            </div>
            {data.checkout_url && (
              <a
                href={data.checkout_url}
                className="mt-5 flex min-h-11 items-center justify-center gap-2 rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90"
              >
                Continue to payment <ArrowUpRight className="size-4" />
              </a>
            )}
          </section>
          <section className="rounded-2xl border bg-card p-6">
            <h2 className="mb-4 flex items-center gap-2 text-sm font-medium">
              <Headphones className="size-4 text-muted-foreground" /> Recording
            </h2>
            {data.call?.audio_available ? (
              <>
                <audio
                  ref={audio}
                  controls
                  preload="metadata"
                  src={audioUrl(id)}
                  className="w-full"
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
                {audioError ? (
                  <p role="alert" className="mt-3 text-xs text-destructive">
                    The recording couldn’t load.{" "}
                    <button
                      className="underline"
                      onClick={() => {
                        setAudioError(false)
                        audio.current?.load()
                      }}
                    >
                      Try again
                    </button>
                  </p>
                ) : (
                  <p className="mt-3 text-xs text-muted-foreground">
                    Select a timestamp in the transcript to jump to that moment.
                  </p>
                )}
              </>
            ) : (
              <p className="text-sm leading-relaxed text-muted-foreground">
                {data.call?.status === "ended"
                  ? "No recording is available for this call."
                  : "The recording will appear here after the call, when available."}
              </p>
            )}
            {data.call?.duration_ms !== undefined && (
              <p className="mt-4 text-xs text-muted-foreground">
                Duration{" "}
                <span className="ml-1 font-mono text-foreground">
                  {clockTime(data.call.duration_ms / 1000)}
                </span>
              </p>
            )}
          </section>
          <p className="flex items-start gap-2 px-1 text-xs leading-relaxed text-muted-foreground">
            <LockKeyhole className="mt-0.5 size-3.5 shrink-0" />
            <span>
              Anyone with your private link can view this call. Access expires{" "}
              {new Date(data.access_expires_at).toLocaleDateString(undefined, {
                dateStyle: "medium",
              })}
              .
            </span>
          </p>
        </div>
        <div>
          <CallTranscript
            turns={turns.data}
            loading={turns.isLoading}
            error={turns.error}
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
            <p className="mt-3 px-1 text-xs text-muted-foreground">
              {connected
                ? "Updates automatically as your call progresses."
                : "Reconnecting to live updates…"}
            </p>
          )}
        </div>
      </div>
    </>
  )
}

const clockTime = (seconds: number) => {
  const value = Math.floor(Math.max(0, seconds))
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, "0")}`
}

function CallTranscript({
  turns,
  live,
  loading,
  error,
  audioStartedAt,
  currentTime,
  onSeek,
}: {
  turns?: Turn[]
  live: boolean
  loading: boolean
  error?: Error
  audioStartedAt?: number
  currentTime: number
  onSeek?: (seconds: number) => void
}) {
  const container = useRef<HTMLDivElement>(null)
  const selected = useRef<HTMLLIElement>(null)
  const follow = useRef(true)
  let current: Turn | undefined
  if (!live && audioStartedAt !== undefined) {
    const at = audioStartedAt + currentTime * 1000
    for (const turn of turns ?? []) {
      const start = turn.started_at ?? turn.at
      if (
        start <= at &&
        (!current || start >= (current.started_at ?? current.at))
      )
        current = turn
    }
  }
  useEffect(() => {
    if (live && follow.current && container.current)
      container.current.scrollTop = container.current.scrollHeight
  }, [live, turns])
  useEffect(() => {
    selected.current?.scrollIntoView({ block: "nearest", behavior: "smooth" })
  }, [current?.seq])

  return (
    <section className="overflow-hidden rounded-2xl border bg-card">
      <div className="flex items-center justify-between border-b px-6 py-5">
        <h2 className="flex items-center gap-2 font-medium">
          <MessageSquare className="size-4 text-muted-foreground" />{" "}
          Conversation
        </h2>
        <span className="text-xs text-muted-foreground">
          {turns?.length ?? 0} turns
        </span>
      </div>
      <div
        ref={container}
        onScroll={() => {
          const el = container.current
          if (el)
            follow.current =
              el.scrollHeight - el.scrollTop - el.clientHeight < 80
        }}
        className="max-h-[36rem] min-h-64 overflow-y-auto p-4 sm:p-6"
      >
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            The transcript couldn’t be loaded. We’ll try again shortly.
          </p>
        ) : loading ? (
          <p role="status" className="text-sm text-muted-foreground">
            Loading the conversation…
          </p>
        ) : !turns?.length ? (
          <div className="flex min-h-52 flex-col items-center justify-center gap-3 text-center text-muted-foreground">
            <MessageSquare className="size-7 opacity-50" />
            <p className="text-sm">
              The conversation will appear here when the call begins.
            </p>
          </div>
        ) : (
          <ol className="space-y-2">
            {turns.map((turn) => {
              const offset =
                audioStartedAt === undefined
                  ? undefined
                  : ((turn.started_at ?? turn.at) - audioStartedAt) / 1000
              const active = current?.seq === turn.seq
              return (
                <li
                  key={turn.seq}
                  ref={active ? selected : undefined}
                  aria-current={active ? "time" : undefined}
                >
                  <button
                    type="button"
                    disabled={!onSeek || offset === undefined}
                    onClick={() => {
                      if (onSeek && offset !== undefined) onSeek(offset)
                    }}
                    className={cn(
                      "w-full rounded-xl border border-transparent p-3 text-left transition-colors focus-visible:outline-2 focus-visible:outline-ring enabled:hover:bg-muted/60",
                      active && "border-primary/20 bg-primary/5",
                      turn.role === "tool" && "bg-muted/40"
                    )}
                  >
                    <span className="mb-1.5 flex items-center justify-between gap-4 text-xs">
                      <span
                        className={cn(
                          "font-medium",
                          turn.role === "agent"
                            ? "text-primary"
                            : "text-muted-foreground"
                        )}
                      >
                        {turn.role === "agent"
                          ? "Agent"
                          : turn.role === "user"
                            ? "Recipient"
                            : "Keypad"}
                      </span>
                      {offset !== undefined && (
                        <span className="font-mono text-muted-foreground">
                          {clockTime(offset)}
                        </span>
                      )}
                    </span>
                    <span className="block text-sm leading-relaxed wrap-anywhere whitespace-pre-wrap">
                      {turn.text}
                    </span>
                  </button>
                </li>
              )
            })}
          </ol>
        )}
      </div>
    </section>
  )
}
