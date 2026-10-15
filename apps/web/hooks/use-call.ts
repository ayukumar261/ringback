"use client"

import { useEffect, useState } from "react"
import useSWR from "swr"
import { callKey, eventsUrl, turnsKey } from "@/lib/api/config"
import { ApiError, fetcher } from "@/lib/api/fetcher"
import type { Call, Turn } from "@/lib/api/types"

const isDenied = (error?: Error) =>
  error instanceof ApiError && [401, 404].includes(error.status)

export function useCall(id: string, onAccessLost: () => void) {
  const [connected, setConnected] = useState(false)
  const call = useSWR<Call, Error>(callKey(id), fetcher, {
    refreshInterval: (data) =>
      data?.call?.status === "ended" ? 30_000 : 5_000,
    shouldRetryOnError: false,
  })
  const turns = useSWR<Turn[], Error>(turnsKey(id), fetcher, {
    refreshInterval: 15_000,
    shouldRetryOnError: false,
  })
  const { mutate: refreshCall } = call
  const { mutate: refreshTurns } = turns

  // Callers also check this while rendering so stale data never paints.
  const denied = isDenied(call.error) || isDenied(turns.error)

  useEffect(() => {
    if (denied) onAccessLost()
  }, [denied, onAccessLost])

  useEffect(() => {
    if (!call.data) return
    const expiresAt = Date.parse(call.data.access_expires_at)
    // Browser timers are limited to a signed 32-bit delay; access lasts 30 days.
    const timeout = setTimeout(
      () => {
        if (Date.now() >= expiresAt) onAccessLost()
        else void refreshCall().catch(() => {})
      },
      Math.min(Math.max(0, expiresAt - Date.now()), 2_147_483_647)
    )
    return () => clearTimeout(timeout)
  }, [call.data, onAccessLost, refreshCall])

  useEffect(() => {
    const source = new EventSource(eventsUrl(id))
    const refresh = () => {
      void refreshCall().catch(() => {})
      void refreshTurns().catch(() => {})
    }
    source.onopen = () => {
      setConnected(true)
    }
    // Headers alone do not guarantee subscription. Ready closes the snapshot gap.
    source.addEventListener("ready", refresh)
    source.onerror = () => {
      setConnected(false)
      refresh()
    }
    source.addEventListener("call.started", refresh)
    source.addEventListener("call.ended", refresh)
    source.addEventListener("call.turn", () => {
      void refreshTurns().catch(() => {})
    })
    source.addEventListener("access.unavailable", () => {
      source.close()
      onAccessLost()
    })
    return () => source.close()
  }, [id, onAccessLost, refreshCall, refreshTurns])

  return { call, turns, connected, denied }
}
