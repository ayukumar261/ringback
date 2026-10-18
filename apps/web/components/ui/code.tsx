"use client"

import { useEffect, useRef, useState, type ReactNode } from "react"

import { Button } from "@/components/ui/button"
import { focusRing } from "@/lib/styles"
import { cn } from "@/lib/utils"

export function Code({
  text,
  language,
  children,
}: {
  text: string
  language?: string
  children: ReactNode
}) {
  const [status, setStatus] = useState("Copy")
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (resetTimer.current) clearTimeout(resetTimer.current)
    }
  }, [])

  async function copy() {
    if (resetTimer.current) clearTimeout(resetTimer.current)

    try {
      await navigator.clipboard.writeText(text)
      setStatus("Copied")
    } catch {
      setStatus("Select to copy")
    }

    resetTimer.current = setTimeout(() => setStatus("Copy"), 2500)
  }

  return (
    <figure
      data-code-block
      className="my-5.5 overflow-hidden rounded-[8px] border border-rule bg-code"
    >
      <figcaption className="flex items-center justify-between gap-4 border-b border-rule py-[5px] pr-2.5 pl-4.5 font-mono text-[11px] text-ink-muted">
        <span>{language === "bash" ? "Terminal" : language || "Code"}</span>
        <Button
          type="button"
          variant="ghost"
          onClick={copy}
          aria-label="Copy code"
          className={cn(
            "min-h-8 min-w-11 rounded-[4px] px-2 text-[11px] font-normal text-ink hover:bg-link hover:text-ink focus-visible:border-transparent focus-visible:ring-0",
            focusRing
          )}
        >
          <span role="status" aria-live="polite">
            {status}
          </span>
        </Button>
      </figcaption>
      {children}
    </figure>
  )
}
