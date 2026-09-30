"use client"

import { useSWRConfig } from "swr"
import useSWRSubscription, {
  type SWRSubscriptionOptions,
} from "swr/subscription"

import { API_URL, CALL_EVENTS_KEY, CALLS_KEY, turnsKey } from "@/lib/api/config"
import type {
  Call,
  CallEndedEvent,
  CallEvent,
  CallStartedEvent,
  CallTurnEvent,
  Turn,
} from "@/lib/api/types"

const byStartedAtDesc = (a: Call, b: Call) =>
  (b.started_at ?? -1) - (a.started_at ?? -1)

function applyEvent(
  calls: readonly Call[] | undefined,
  event: CallStartedEvent | CallEndedEvent
): Call[] {
  const prev = calls ?? []
  const existing = prev.find((c) => c.room === event.room)
  const next: Call =
    event.event === "call.started"
      ? {
          // like the server's $setOnInsert: a replayed start never revives an ended call
          ...(existing ?? {
            room: event.room,
            status: "active",
            started_at: event.started_at,
          }),
          conversation_id: event.conversation_id ?? "",
          from: event.from ?? "",
          to: event.to ?? "",
          direction: event.direction ?? "",
          prompt: event.prompt ?? "",
        }
      : {
          ...(existing ?? { room: event.room }),
          status: "ended",
          ended_at: event.ended_at,
          duration_ms: event.duration_ms,
          audio: event.audio ?? "",
          ...(event.audio_started_at !== undefined && {
            audio_started_at: event.audio_started_at,
          }),
        }
  return [...prev.filter((c) => c.room !== event.room), next].sort(
    byStartedAtDesc
  )
}

function applyTurn(
  turns: readonly Turn[] | undefined,
  event: CallTurnEvent
): Turn[] {
  const prev = turns ?? []
  const existing = prev.find((t) => t.seq === event.seq)
  const turn: Turn = {
    ...existing,
    room: event.room,
    seq: event.seq,
    role: event.role,
    text: event.text,
    at: event.at,
    ...(event.started_at !== undefined && { started_at: event.started_at }),
    ...(event.ended_at !== undefined && { ended_at: event.ended_at }),
    ...(event.duration_ms !== undefined && { duration_ms: event.duration_ms }),
  }
  // Like the server's upsert, a correction keeps any timing it did not supply.
  return [...prev.filter((t) => t.seq !== turn.seq), turn].sort(
    (a, b) => a.seq - b.seq
  )
}

export function useCallsStream() {
  const { mutate } = useSWRConfig()
  return useSWRSubscription<CallEvent, Error>(
    CALL_EVENTS_KEY,
    (key: string, { next }: SWRSubscriptionOptions<CallEvent, Error>) => {
      const source = new EventSource(`${API_URL}${key}`)
      const deliver = (message: MessageEvent<string>) => {
        let event: CallEvent
        try {
          event = JSON.parse(message.data) as CallEvent
        } catch (error) {
          next(error instanceof Error ? error : new Error(String(error)))
          return
        }
        if (event.event === "call.turn") {
          void mutate<Turn[]>(
            turnsKey(event.room),
            (turns) => applyTurn(turns, event),
            { revalidate: false }
          )
        } else {
          void mutate<Call[]>(CALLS_KEY, (calls) => applyEvent(calls, event), {
            revalidate: false,
          })
        }
        next(null, event)
      }
      source.addEventListener("call.started", deliver)
      source.addEventListener("call.ended", deliver)
      source.addEventListener("call.turn", deliver)
      source.onerror = () => next(new Error("calls stream disconnected"))
      return () => source.close()
    }
  )
}
