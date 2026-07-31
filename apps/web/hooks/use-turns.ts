"use client"

import useSWR from "swr"

import { turnsKey } from "@/lib/api/config"
import { ApiError, fetcher } from "@/lib/api/fetcher"
import type { Turn } from "@/lib/api/types"

// 404 means the api has no turns endpoint yet: start empty, the stream fills it
async function fetchTurns(path: string): Promise<Turn[]> {
  try {
    return await fetcher<Turn[]>(path)
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return []
    throw error
  }
}

// useTurns tracks one call's transcript, kept live by useCallsStream.
export function useTurns(room: string) {
  return useSWR<Turn[], Error>(turnsKey(room), fetchTurns)
}
