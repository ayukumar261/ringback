"use client"

import {
  use,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
  type RefObject,
} from "react"
import Link from "next/link"
import {
  ArrowDown,
  AudioLines,
  Check,
  ChevronDown,
  ChevronRight,
  Clock3,
  Copy,
  Download,
  LoaderCircle,
  LockKeyhole,
  MessageSquare,
  Monitor,
  Moon,
  Pause,
  Phone,
  PhoneOff,
  Play,
  RotateCcw,
  RotateCw,
  Sun,
} from "lucide-react"
import { useTheme } from "next-themes"
import { SWRConfig } from "swr"
import { Button, buttonVariants } from "@/components/ui/button"
import { Card, CardContent, CardHeader } from "@/components/ui/card"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Separator } from "@/components/ui/separator"
import { Skeleton } from "@/components/ui/skeleton"
import { Slider } from "@/components/ui/slider"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { useCall } from "@/hooks/use-call"
import { API_URL, audioUrl, callKey } from "@/lib/api/config"
import type { Call, Turn } from "@/lib/api/types"
import { focusRing, link } from "@/lib/styles"
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

// Trades the link's token for a call-scoped cookie. Without a token, an
// existing HttpOnly cookie may already authorize this visit.
async function requestAccess(
  id: string,
  token: string | null,
  handoff: string | null
) {
  if (token === null && handoff === null) return true
  try {
    const response = await fetch(`${API_URL}${callKey(id)}/access`, {
      method: "POST",
      headers:
        token !== null
          ? { Authorization: `Bearer ${token}` }
          : { "X-Checkout-Handoff": handoff! },
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
      const credentials = new URLSearchParams(fragment.slice(1))
      pending.current ??= requestAccess(
        id,
        credentials.get("token"),
        credentials.get("handoff")
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
    <main
      data-call-dashboard
      className="min-h-svh bg-paper text-[14px] leading-relaxed text-ink antialiased"
    >
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

type CallState =
  "unpaid" | "preparing" | "dialing" | "active" | "ended" | "expired" | "failed"

const emptyStates = {
  unpaid: {
    title: "Ready when you are",
    description:
      "Complete payment to start the call. The conversation will appear here as it happens.",
    icon: Phone,
  },
  preparing: {
    title: "Getting the call ready",
    description:
      "Your call will start shortly. You can keep this page open to follow the conversation.",
    icon: Phone,
  },
  dialing: {
    title: "Waiting for an answer",
    description:
      "The phone is ringing. The conversation will appear here when someone picks up.",
    icon: Phone,
  },
  active: {
    title: "The call is connected",
    description:
      "Waiting for the first words. The transcript will update as the conversation unfolds.",
    icon: AudioLines,
  },
  ended: {
    title: "No transcript available",
    description: "This call has ended, but there is no transcript available.",
    icon: MessageSquare,
  },
  expired: {
    title: "This call wasn’t started",
    description: "The payment window has closed. No call was placed.",
    icon: Clock3,
  },
  failed: {
    title: "The call couldn’t be placed",
    description:
      "Something went wrong while placing this call. Any available call details are shown here.",
    icon: PhoneOff,
  },
}

function callState(data: Call, expired: boolean): CallState {
  if (data.call?.status === "ended") return "ended"
  if (data.call?.status === "active") return "active"
  if (expired || data.status === "expired") return "expired"
  if (data.status === "failed") return "failed"
  if (data.status === "unpaid") return "unpaid"
  if (data.status === "paid") return "preparing"
  return "dialing"
}

function CallPlaceholder({
  loading = false,
  onRetry,
}: {
  loading?: boolean
  onRetry?: () => void
}) {
  if (loading) {
    return (
      <div
        role="status"
        aria-label="Loading call"
        className="fixed inset-0 grid place-items-center text-muted-foreground"
      >
        <LoaderCircle
          aria-hidden="true"
          className="size-5 animate-spin motion-reduce:animate-none"
        />
      </div>
    )
  }

  return (
    <div
      role="status"
      aria-label="Call unavailable"
      className="mx-auto flex min-h-[75svh] max-w-sm flex-col items-center justify-center px-6 text-center"
    >
      <span className="mb-5 grid size-11 place-items-center rounded-xl border border-rule bg-code/50 text-ink-muted shadow-[0_1px_2px_#00000003]">
        <LockKeyhole aria-hidden="true" className="size-4" />
      </span>
      <h1 className="text-[15px] font-medium tracking-[-0.02em]">
        This call is unavailable
      </h1>
      <p className="mt-2 text-[13px] leading-6 text-ink-muted">
        {onRetry
          ? "We couldn’t load the call. Please try again."
          : "Open the original private link to view this call. It may have expired or you may not have access."}
      </p>
      {onRetry && (
        <Button variant="outline" onClick={onRetry} className="mt-4">
          Try again
        </Button>
      )}
    </div>
  )
}

function CallContent({
  id,
  onAccessLost,
}: {
  id: string
  onAccessLost: () => void
}) {
  const { call, turns, connected, denied, checkoutExpired } = useCall(
    id,
    onAccessLost
  )
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState<number>()
  const audio = useRef<HTMLAudioElement>(null)
  if (denied) return <CallPlaceholder />
  const data = call.data
  if (!data)
    return (
      <CallPlaceholder
        loading={!call.error}
        onRetry={
          call.error ? () => void call.mutate().catch(() => {}) : undefined
        }
      />
    )

  const state = callState(data, checkoutExpired)
  const waiting = emptyStates[state]
  const EmptyIcon = waiting.icon
  const live = state === "active"
  const finished = ["ended", "expired", "failed"].includes(state)
  const audioStartedAt =
    data.call?.audio_started_at ??
    (data.call?.ended_at !== undefined && duration !== undefined
      ? data.call.ended_at - duration * 1000
      : undefined)
  const seek = (seconds: number) => {
    if (!audio.current || duration === undefined) return
    audio.current.currentTime = Math.max(0, Math.min(seconds, duration))
    setCurrentTime(audio.current.currentTime)
  }
  const price = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: data.currency,
  }).format(data.amount / 100)
  const updates = !finished && state !== "unpaid"
  const recording =
    live || data.call?.audio_available ? (
      <RecordingPlayer
        id={id}
        available={!!data.call?.audio_available}
        audio={audio}
        currentTime={currentTime}
        duration={duration}
        onTimeChange={setCurrentTime}
        onDurationChange={setDuration}
        onSeek={seek}
        onError={() => void call.mutate().catch(() => {})}
      />
    ) : undefined

  return (
    <div className="mx-auto w-full max-w-[960px] px-5 pt-6 pb-8 sm:px-8 sm:pt-12 lg:px-0 lg:pt-16">
      <header>
        <div className="flex h-8 items-center justify-between gap-4 text-[12px] text-muted-foreground">
          <Link
            href="/"
            className={cn(
              "font-semibold tracking-[-0.025em] text-ink",
              focusRing
            )}
          >
            Corbyn AI
          </Link>
          <div className="-mr-2">
            <CallThemeMenu />
          </div>
        </div>
        <h1 className="py-6 text-[24px] leading-tight font-semibold tracking-[-0.04em] tabular-nums sm:text-[30px]">
          {formatPhone(data.to)}
        </h1>
      </header>

      <div className="grid items-start gap-8 lg:grid-cols-[minmax(0,1fr)_240px] lg:gap-10">
        <div className="min-w-0">
          {call.error && (
            <p
              role="status"
              className="mb-4 rounded-lg border border-border bg-muted px-4 py-3 text-[12px] leading-5 text-muted-foreground"
            >
              Updates are temporarily unavailable. Reconnecting…
            </p>
          )}
          <Card
            role="region"
            aria-labelledby="conversation-heading"
            className="gap-0 border border-border py-0 shadow-[0_1px_2px_#00000003] ring-0"
          >
            {!turns.error && turns.data?.length ? (
              <Transcript
                turns={estimateRecipientSpans(turns.data, audioStartedAt)}
                live={live}
                connected={connected}
                updates={updates}
                recording={recording}
                currentTime={currentTime}
                audioStartedAt={audioStartedAt}
                onSeek={
                  data.call?.audio_available && duration !== undefined
                    ? seek
                    : undefined
                }
              />
            ) : (
              <>
                <ConversationHeader connected={connected} updates={updates} />
                {recording}
                <CardContent className="p-0">
                  {turns.error ? (
                    <div
                      role="alert"
                      className="flex min-h-72 flex-col items-center justify-center gap-3 px-6 py-10 text-center"
                    >
                      <p className="text-[13px] font-medium">
                        The transcript couldn’t load
                      </p>
                      <Button
                        variant="outline"
                        size="lg"
                        onClick={() => void turns.mutate().catch(() => {})}
                      >
                        Try again
                      </Button>
                    </div>
                  ) : turns.isLoading ? (
                    <div
                      role="status"
                      aria-label="Loading transcript"
                      className="space-y-6 p-5"
                    >
                      {["w-3/4", "w-full", "w-1/2"].map((width) => (
                        <div key={width} className="space-y-3">
                          <Skeleton className="h-2.5 w-16 motion-reduce:animate-none" />
                          <Skeleton
                            className={cn(
                              "h-2.5 motion-reduce:animate-none",
                              width
                            )}
                          />
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="flex min-h-80 flex-col items-center justify-center px-6 py-10 text-center">
                      <span className="mb-4 grid size-9 place-items-center rounded-lg border border-border bg-muted/50 text-muted-foreground">
                        <EmptyIcon aria-hidden="true" className="size-4" />
                      </span>
                      <h3 className="text-[14px] font-medium tracking-[-0.015em]">
                        {waiting.title}
                      </h3>
                      <p className="mt-2 max-w-[285px] text-[13px] leading-6 text-muted-foreground">
                        {waiting.description}
                      </p>
                      {state === "unpaid" && data.checkout_url && (
                        <>
                          <a
                            href={data.checkout_url}
                            className={cn(
                              buttonVariants({ size: "lg" }),
                              "mt-5 h-9 gap-2 px-3"
                            )}
                          >
                            Continue to payment
                            <ChevronRight
                              aria-hidden="true"
                              className="size-3.5"
                            />
                          </a>
                          <p className="mt-2 text-[11px] text-muted-foreground">
                            {price} {data.currency.toUpperCase()}
                            <span aria-hidden="true" className="mx-1.5">
                              ·
                            </span>
                            Up to {formatLimit(data.max_duration_seconds)}
                          </p>
                        </>
                      )}
                    </div>
                  )}
                </CardContent>
              </>
            )}
          </Card>
        </div>

        <aside className="min-w-0 border-t border-border pt-2 md:grid md:grid-cols-2 md:gap-x-10 lg:block lg:border-t-0 lg:pt-0">
          <section aria-labelledby="prompt-heading">
            <h2
              id="prompt-heading"
              className="flex h-12 items-center text-[13px] font-medium"
            >
              Prompt
            </h2>
            <div
              role="region"
              aria-label="Prompt"
              tabIndex={0}
              className="max-h-72 [scrollbar-width:thin] [scrollbar-color:var(--border)_transparent] overflow-y-auto focus-visible:rounded focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
            >
              <p className="text-[13px] leading-[1.85] wrap-anywhere whitespace-pre-wrap selection:bg-foreground/15">
                {data.prompt}
              </p>
            </div>
          </section>
          <Separator className="my-6 md:hidden lg:block" />
          <section aria-label="Call details">
            <h2 className="mb-4 text-[13px] font-medium md:mb-0 md:flex md:h-12 md:items-center lg:mb-4 lg:block lg:h-auto">
              Details
            </h2>
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-4 gap-y-2.5 text-[12px] leading-5">
              {data.call?.duration_ms !== undefined && (
                <>
                  <dt className="text-muted-foreground">Duration</dt>
                  <dd className="text-right font-mono text-[11px] tabular-nums">
                    {formatTime(data.call.duration_ms / 1000)}
                  </dd>
                </>
              )}
              <dt className="text-muted-foreground">Created</dt>
              <dd className="text-right">{formatDate(data.created_at)}</dd>
              {data.call?.ended_at !== undefined && (
                <>
                  <dt className="text-muted-foreground">Ended</dt>
                  <dd className="text-right">
                    {formatDate(data.call.ended_at)}
                  </dd>
                </>
              )}
              <dt className="text-muted-foreground">Expires</dt>
              <dd className="text-right">
                {formatDate(data.access_expires_at)}
              </dd>
            </dl>
          </section>
        </aside>
      </div>

      <footer className="mt-8 flex flex-wrap items-center justify-between gap-4 border-t border-border pt-4 text-[12px] leading-5 text-muted-foreground">
        <span>© {new Date().getFullYear()} Corbyn AI</span>
        <nav className="flex flex-wrap gap-2" aria-label="Legal">
          <Link href="/terms-and-conditions" className={link}>
            Terms and Conditions
          </Link>
          <Link href="/privacy-policy" className={link}>
            Privacy Policy
          </Link>
        </nav>
      </footer>
    </div>
  )
}

function RecordingPlayer({
  id,
  available,
  audio,
  currentTime,
  duration,
  onTimeChange,
  onDurationChange,
  onSeek,
  onError,
}: {
  id: string
  available: boolean
  audio: RefObject<HTMLAudioElement | null>
  currentTime: number
  duration?: number
  onTimeChange: (seconds: number) => void
  onDurationChange: (seconds: number) => void
  onSeek: (seconds: number) => void
  onError: () => void
}) {
  const [playing, setPlaying] = useState(false)
  const [failed, setFailed] = useState(false)
  const [speed, setSpeed] = useState("1")
  const hintId = useId()
  const disabled = !available || failed

  function fail() {
    setFailed(true)
    setPlaying(false)
    onError()
  }

  async function togglePlayback() {
    const element = audio.current
    if (!element) return
    if (!element.paused) {
      element.pause()
      return
    }
    try {
      await element.play()
    } catch {
      fail()
    }
  }

  return (
    <section
      aria-label="Recording"
      aria-disabled={!available || undefined}
      aria-describedby={!available ? hintId : undefined}
      className="border-b border-border bg-muted/35 px-5 py-5"
    >
      {available && (
        <audio
          ref={audio}
          preload="metadata"
          src={audioUrl(id)}
          aria-label="Call recording"
          onTimeUpdate={(event) =>
            onTimeChange(event.currentTarget.currentTime)
          }
          onDurationChange={(event) => {
            const value = event.currentTarget.duration
            if (Number.isFinite(value)) onDurationChange(value)
          }}
          onLoadedMetadata={(event) => {
            event.currentTarget.playbackRate = Number(speed)
          }}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => setPlaying(false)}
          onError={fail}
        />
      )}
      <div className="grid grid-cols-[2rem_minmax(0,1fr)_2rem] items-center gap-3 font-mono text-[10px] leading-none text-muted-foreground tabular-nums">
        <span
          className={cn("flex h-6 items-center", !available && "opacity-50")}
        >
          {formatTime(currentTime)}
        </span>
        <Slider
          min={0}
          max={duration || 1}
          step={0.1}
          value={[Math.min(currentTime, duration ?? 0)]}
          disabled={disabled || !duration}
          onValueChange={(value) =>
            onSeek(typeof value === "number" ? value : value[0])
          }
          thumbProps={{
            "aria-label": "Recording position",
            "aria-valuetext": `${formatTime(currentTime)} of ${formatTime(duration ?? 0)}`,
          }}
          className="flex h-6 min-w-0 items-center [&_[data-slot=slider-track]]:bg-border [&_[data-slot=slider-track]]:data-horizontal:h-0.5"
        />
        <span
          className={cn(
            "flex h-6 items-center justify-end",
            !available && "opacity-50"
          )}
        >
          {duration === undefined ? "—:——" : formatTime(duration)}
        </span>
      </div>
      <div className="mt-2 grid grid-cols-[1fr_auto_1fr] items-center gap-2">
        <div className="-ml-2 justify-self-start">
          <DropdownMenu>
            <DropdownMenuTrigger
              disabled={disabled}
              render={
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label="Playback speed"
                  className="h-8 gap-1.5 text-[11px] font-normal text-muted-foreground"
                />
              }
            >
              {speed}×
              <ChevronDown aria-hidden="true" className="size-3" />
            </DropdownMenuTrigger>
            <DropdownMenuContent
              data-call-dashboard
              align="start"
              className="w-36 motion-reduce:animate-none"
            >
              <DropdownMenuGroup>
                <DropdownMenuLabel>Playback speed</DropdownMenuLabel>
                <DropdownMenuRadioGroup
                  value={speed}
                  onValueChange={(value) => {
                    setSpeed(value)
                    if (audio.current)
                      audio.current.playbackRate = Number(value)
                  }}
                >
                  {["0.75", "1", "1.25", "1.5", "2"].map((value) => (
                    <DropdownMenuRadioItem
                      key={value}
                      value={value}
                      closeOnClick
                    >
                      {value}×
                      {value === "1" && (
                        <span className="text-muted-foreground">Normal</span>
                      )}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <div className="flex items-center gap-2">
          <CallAction
            label="Back 10 seconds"
            disabled={disabled || !duration}
            onClick={() => onSeek(currentTime - 10)}
          >
            <RotateCcw aria-hidden="true" className="size-3.5" />
          </CallAction>
          <CallAction
            label={playing ? "Pause recording" : "Play recording"}
            variant="outline"
            disabled={disabled}
            onClick={togglePlayback}
            className="rounded-full bg-background text-foreground shadow-xs"
          >
            {playing ? (
              <Pause aria-hidden="true" className="size-3.5 fill-current" />
            ) : (
              <Play
                aria-hidden="true"
                className="ml-px size-3.5 fill-current"
              />
            )}
          </CallAction>
          <CallAction
            label="Forward 10 seconds"
            disabled={disabled || !duration}
            onClick={() => onSeek(currentTime + 10)}
          >
            <RotateCw aria-hidden="true" className="size-3.5" />
          </CallAction>
        </div>
        <div className="-mr-2 justify-self-end">
          <CallAction
            label="Download recording"
            disabled={disabled}
            render={
              available ? (
                <a href={audioUrl(id)} download={`call-${id}.wav`} />
              ) : undefined
            }
            nativeButton={!available}
          >
            <Download aria-hidden="true" className="size-3.5" />
          </CallAction>
        </div>
      </div>
      {!available && (
        <p
          id={hintId}
          className="mt-3 text-center text-[11px] leading-4 text-muted-foreground"
        >
          Playback is available after the call ends.
        </p>
      )}
      {failed && (
        <div
          role="alert"
          className="mt-2 flex flex-wrap items-center justify-between gap-2 text-[12px] text-muted-foreground"
        >
          <p>The recording couldn’t load.</p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setFailed(false)
              audio.current?.load()
            }}
          >
            Try again
          </Button>
        </div>
      )}
    </section>
  )
}

const speakers = { agent: "Assistant", user: "Recipient", tool: "Tool" }

const turnStart = (turn: Turn) => turn.started_at ?? turn.at

// Recipient turns without detected speech span from the previous turn's end to their transcript.
function estimateRecipientSpans(turns: Turn[], audioStartedAt?: number) {
  return turns.map((turn, index): Turn => {
    if (turn.role !== "user" || turn.started_at !== undefined) return turn
    const previous = turns[index - 1]
    const start = previous
      ? (previous.ended_at ?? previous.at)
      : (audioStartedAt ?? turn.at)
    return { ...turn, started_at: Math.min(start, turn.at), ended_at: turn.at }
  })
}

function offsetLabel(milliseconds: number) {
  return `${milliseconds < 0 ? "−" : ""}${formatTime(Math.abs(milliseconds) / 1000)}`
}

function ConversationHeader({
  count,
  updates,
  connected,
  children,
}: {
  count?: number
  updates?: boolean
  connected?: boolean
  children?: ReactNode
}) {
  return (
    <>
      <CardHeader className="flex h-12 flex-row items-center justify-between gap-3 px-5">
        <div className="flex min-w-0 items-baseline gap-2">
          <h2 id="conversation-heading" className="text-[13px] font-medium">
            Conversation
          </h2>
          {count !== undefined && (
            <span className="hidden text-[11px] text-muted-foreground sm:inline">
              {count} messages
            </span>
          )}
        </div>
        <div className="-mr-2 flex items-center gap-2">
          {updates && (
            <span
              role="status"
              className="flex items-center gap-1.5 text-[11px] text-muted-foreground"
            >
              <span
                aria-hidden="true"
                className={cn(
                  "size-1.5 rounded-full",
                  connected ? "call-live-dot" : "bg-muted-foreground/40"
                )}
              />
              {connected ? "Live" : "Reconnecting…"}
            </span>
          )}
          {children}
        </div>
      </CardHeader>
      <Separator />
    </>
  )
}

function Transcript({
  turns,
  live,
  connected,
  updates,
  recording,
  currentTime,
  audioStartedAt,
  onSeek,
}: {
  turns: Turn[]
  live: boolean
  connected: boolean
  updates: boolean
  recording?: ReactNode
  currentTime: number
  audioStartedAt?: number
  onSeek?: (seconds: number) => void
}) {
  const viewport = useRef<HTMLDivElement>(null)
  const currentRow = useRef<HTMLLIElement>(null)
  const following = useRef(true)
  const [pausedFollowing, setPausedFollowing] = useState(false)
  const [copyStatus, setCopyStatus] = useState("")
  const reset = useRef<ReturnType<typeof setTimeout> | null>(null)
  let current: Turn | undefined
  if (live) {
    current = turns.at(-1)
  } else if (audioStartedAt !== undefined) {
    const instant = audioStartedAt + currentTime * 1000
    for (const turn of turns) {
      const start = turnStart(turn)
      if (
        start <= instant &&
        (turn.ended_at === undefined || instant < turn.ended_at) &&
        (current === undefined || start >= turnStart(current))
      )
        current = turn
    }
  }

  useEffect(() => {
    const container = viewport.current
    const row = currentRow.current
    if (!container || !row) return
    if (live) {
      if (following.current) container.scrollTop = container.scrollHeight
    } else {
      // Follow playback inside the transcript without moving the page itself.
      const top = row.offsetTop
      const bottom = top + row.offsetHeight
      if (top < container.scrollTop) container.scrollTop = top
      else if (bottom > container.scrollTop + container.clientHeight)
        container.scrollTop = bottom - container.clientHeight
    }
  }, [current?.seq, current?.text, live])

  useEffect(
    () => () => {
      if (reset.current) clearTimeout(reset.current)
    },
    []
  )

  async function copyTranscript() {
    if (reset.current) clearTimeout(reset.current)
    const text = turns
      .map((turn) => {
        const offset =
          audioStartedAt === undefined
            ? ""
            : `${offsetLabel(turnStart(turn) - audioStartedAt)} `
        return `${offset}${speakers[turn.role]}\n${turn.text}`
      })
      .join("\n\n")
    try {
      await navigator.clipboard.writeText(text)
      setCopyStatus("Transcript copied")
    } catch {
      setCopyStatus("Select the text to copy")
    }
    reset.current = setTimeout(() => setCopyStatus(""), 2500)
  }

  return (
    <>
      <ConversationHeader
        count={turns.length}
        connected={connected}
        updates={updates}
      >
        <span
          role="status"
          aria-label="Transcript copy status"
          className="sr-only"
        >
          {copyStatus}
        </span>
        <CallAction label="Copy transcript" onClick={copyTranscript}>
          {copyStatus === "Transcript copied" ? (
            <Check aria-hidden="true" className="size-3.5" />
          ) : (
            <Copy aria-hidden="true" className="size-3.5" />
          )}
        </CallAction>
      </ConversationHeader>
      {recording}
      <div
        ref={viewport}
        role="region"
        aria-label="Call transcript"
        tabIndex={0}
        onScroll={() => {
          const container = viewport.current
          if (!container || !live) return
          following.current =
            container.scrollHeight -
              container.scrollTop -
              container.clientHeight <
            64
          setPausedFollowing(!following.current)
        }}
        className="relative max-h-[min(560px,65svh)] [scrollbar-width:thin] [scrollbar-color:var(--border)_transparent] overflow-y-auto overscroll-contain focus-visible:outline-2 focus-visible:outline-offset-[-3px] focus-visible:outline-ring"
      >
        <ol
          className="divide-y divide-border/70"
          aria-live={live ? "polite" : "off"}
          aria-relevant="additions text"
        >
          {turns.map((turn) => {
            const offset =
              audioStartedAt === undefined
                ? undefined
                : turnStart(turn) - audioStartedAt
            const isCurrent = turn.seq === current?.seq
            const seekTo =
              onSeek && offset !== undefined
                ? () => onSeek(offset / 1000)
                : undefined
            const content = (
              <>
                <span className="mb-1.5 flex h-5 items-center justify-between gap-4">
                  <span
                    className={cn(
                      "flex items-center gap-2 text-[11px] font-medium",
                      turn.role !== "agent" && "text-muted-foreground"
                    )}
                  >
                    <span
                      aria-hidden="true"
                      className={cn(
                        "size-1.5 rounded-full bg-foreground/60",
                        turn.role === "user" && "bg-muted-foreground/40",
                        turn.role === "tool" &&
                          "rounded-xs bg-transparent ring-1 ring-muted-foreground/50"
                      )}
                    />
                    {speakers[turn.role]}
                  </span>
                  {offset !== undefined && (
                    <span className="font-mono text-[10px] text-muted-foreground tabular-nums">
                      {offsetLabel(offset)}
                    </span>
                  )}
                </span>
                <span className="block text-[14px] leading-[1.75] wrap-anywhere whitespace-pre-wrap selection:bg-foreground/15">
                  {turn.text}
                </span>
              </>
            )
            return (
              <li
                key={turn.seq}
                ref={isCurrent ? currentRow : undefined}
                aria-current={isCurrent ? "time" : undefined}
                className={cn(
                  "relative",
                  isCurrent &&
                    "bg-muted/60 before:absolute before:inset-y-4 before:left-0 before:w-0.5 before:rounded-r before:bg-foreground/40"
                )}
              >
                {seekTo ? (
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={seekTo}
                    aria-label={`Seek to ${offsetLabel(offset!)}: ${speakers[turn.role]}. ${turn.text}`}
                    title="Seek to this turn"
                    className="block h-auto w-full rounded-none border-0 px-5 py-4 text-left font-normal whitespace-normal select-text focus-visible:ring-0 focus-visible:outline-2 focus-visible:outline-offset-[-3px] focus-visible:outline-ring active:not-aria-[haspopup]:translate-y-0 motion-reduce:transition-none"
                  >
                    {content}
                  </Button>
                ) : (
                  <div className="px-5 py-4">{content}</div>
                )}
              </li>
            )
          })}
        </ol>
      </div>
      {live && pausedFollowing && (
        <div className="flex h-11 items-center justify-between gap-3 border-t border-border bg-muted/40 pr-3 pl-5 text-[11px] text-muted-foreground">
          <span>Scroll paused</span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              following.current = true
              setPausedFollowing(false)
              if (viewport.current)
                viewport.current.scrollTop = viewport.current.scrollHeight
            }}
            className="h-8 gap-1 text-[11px]"
          >
            Jump to latest
            <ArrowDown aria-hidden="true" className="size-3" />
          </Button>
        </div>
      )}
    </>
  )
}

function CallAction({
  label,
  className,
  children,
  ...props
}: ComponentProps<typeof Button> & { label: string }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={label}
            className={cn(
              "size-8 text-muted-foreground hover:text-foreground motion-reduce:transition-none",
              className
            )}
            {...props}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent
        data-call-dashboard
        className="motion-reduce:animate-none"
      >
        {label}
      </TooltipContent>
    </Tooltip>
  )
}

function CallThemeMenu() {
  const { theme, setTheme } = useTheme()
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            aria-label="Change theme"
            className="size-8 text-muted-foreground hover:text-foreground"
          />
        }
      >
        <Sun aria-hidden="true" className="size-3.5 dark:hidden" />
        <Moon aria-hidden="true" className="hidden size-3.5 dark:block" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        data-call-dashboard
        align="end"
        className="w-40 motion-reduce:animate-none"
      >
        <DropdownMenuGroup>
          <DropdownMenuLabel>Appearance</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={theme ?? "system"}
            onValueChange={setTheme}
          >
            <DropdownMenuRadioItem value="light" closeOnClick>
              <Sun aria-hidden="true" />
              Light
            </DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="dark" closeOnClick>
              <Moon aria-hidden="true" />
              Dark
            </DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="system" closeOnClick>
              <Monitor aria-hidden="true" />
              System
            </DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function formatPhone(number: string) {
  return number.replace(/^\+1(\d{3})(\d{3})(\d{4})$/, "+1 ($1) $2-$3")
}

function formatTime(seconds: number) {
  const whole = Math.max(0, Math.floor(seconds))
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`
}

function formatDate(value: string | number) {
  return new Date(value).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  })
}

function formatLimit(seconds: number) {
  return seconds < 60 ? `${seconds} sec` : `${Math.floor(seconds / 60)} min`
}
