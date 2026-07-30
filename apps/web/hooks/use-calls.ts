"use client"

import useSWR from "swr"

import { CALLS_KEY } from "@/lib/api/config"
import { ApiError, fetcher } from "@/lib/api/fetcher"
import type { Call } from "@/lib/api/types"

// 404 means the api has no snapshot endpoint yet: start empty, the stream fills it
async function fetchCalls(path: string): Promise<Call[]> {
  try {
    return await fetcher<Call[]>(path)
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return []
    throw error
  }
}

export function useCalls() {
  return useSWR<Call[], Error>(CALLS_KEY, fetchCalls)
}
