"use client"

import type { ReactNode } from "react"
import { SWRConfig } from "swr"

import { fetcher } from "@/lib/api/fetcher"

// SWRProvider wires the api fetcher into every useSWR call below it.
function SWRProvider({ children }: { children: ReactNode }) {
  return <SWRConfig value={{ fetcher }}>{children}</SWRConfig>
}

export { SWRProvider }
