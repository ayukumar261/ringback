"use client"

import { useEffect, useId, useRef, useState } from "react"

import { cn } from "@/lib/utils"
import { link, listItem, orderedList, paragraph } from "@/lib/styles"

// A heading counts as the current section once it scrolls within this many pixels of the top.
const ACTIVE_OFFSET = 96

// Scrolling has settled once no scroll event arrives for this long.
const SETTLE_MS = 150

export type Section = { id: string; title: string }

// Contents lists the page's sections inline on narrow screens and as a sticky sidebar on wide ones.
export function Contents({ sections }: { sections: readonly Section[] }) {
  const titleId = useId()
  const nav = useRef<HTMLElement>(null)
  const [active, setActive] = useState<string | undefined>(sections[0]?.id)

  useEffect(() => {
    const headings = sections
      .map(({ id }) => document.getElementById(id))
      .filter((heading) => heading !== null)
    let frame = 0
    // A clicked section keeps the highlight while the page glides past the sections before it.
    let held = false
    let settle = 0

    const update = () => {
      frame = 0
      const root = document.documentElement
      // The last sections may never reach the top, so the page's end selects the last one.
      const atEnd = window.innerHeight + window.scrollY >= root.scrollHeight - 1
      const passed = headings.filter(
        (heading) => heading.getBoundingClientRect().top <= ACTIVE_OFFSET
      )
      setActive((atEnd ? headings.at(-1) : (passed.at(-1) ?? headings[0]))?.id)
    }
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update)
    }
    // The clicked section stays highlighted until the reader scrolls again, even if it can't reach the top.
    const holdUntilSettled = () => {
      window.clearTimeout(settle)
      settle = window.setTimeout(() => {
        held = false
      }, SETTLE_MS)
    }
    const onScroll = () => {
      if (held) holdUntilSettled()
      else schedule()
    }
    const onClick = (event: MouseEvent) => {
      const link = (event.target as Element).closest<HTMLAnchorElement>(
        'a[href^="#"]'
      )
      if (!link) return
      held = true
      setActive(link.hash.slice(1))
      holdUntilSettled()
    }

    schedule()
    const list = nav.current
    list?.addEventListener("click", onClick)
    window.addEventListener("scroll", onScroll, { passive: true })
    window.addEventListener("resize", schedule)
    return () => {
      cancelAnimationFrame(frame)
      window.clearTimeout(settle)
      list?.removeEventListener("click", onClick)
      window.removeEventListener("scroll", onScroll)
      window.removeEventListener("resize", schedule)
    }
  }, [sections])

  return (
    // Narrow screens show the list inline like the article's own lists; wide screens move it into the left margin.
    <nav
      ref={nav}
      aria-labelledby={titleId}
      className="xl:absolute xl:top-0 xl:right-[calc(100%+56px)] xl:bottom-0 xl:w-42"
    >
      <div className="xl:sticky xl:top-8 xl:max-h-[calc(100svh-64px)] xl:overflow-y-auto">
        <p
          id={titleId}
          className={cn(
            paragraph,
            "xl:mb-2.5 xl:text-[12px] xl:leading-normal xl:text-ink-muted"
          )}
        >
          On this page
        </p>
        <ol className={cn(orderedList, "xl:m-0 xl:list-none xl:p-0")}>
          {sections.map(({ id, title }) => (
            <li key={id} className={cn(listItem, "xl:m-0 xl:p-0")}>
              <a
                href={`#${id}`}
                aria-current={active === id ? "location" : undefined}
                className={cn(
                  link,
                  "xl:block xl:rounded-none xl:border-l xl:border-rule xl:bg-transparent xl:py-1 xl:pr-0 xl:pl-3 xl:text-[13px] xl:leading-normal xl:text-ink-muted xl:hover:bg-transparent xl:hover:text-ink xl:aria-[current=location]:border-ink xl:aria-[current=location]:text-ink"
                )}
              >
                {title}
              </a>
            </li>
          ))}
        </ol>
      </div>
    </nav>
  )
}
