import Image from "next/image"
import type { ComponentProps } from "react"

import { cn } from "@/lib/utils"
import { link } from "@/lib/styles"

function faviconFor(href?: string) {
  if (!href) return undefined

  try {
    const url = new URL(href)
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined
    return `${url.origin}/favicon.ico`
  } catch {
    return undefined
  }
}

export function Link({
  href,
  children,
  className,
  ...props
}: ComponentProps<"a">) {
  const favicon = faviconFor(href)

  return (
    <a
      href={href}
      className={cn(link, "inline-block max-w-full leading-[1.25]", className)}
      {...props}
    >
      {favicon && (
        <Image
          src={favicon}
          alt=""
          aria-hidden="true"
          width={14}
          height={14}
          unoptimized
          loading="eager"
          className="mr-[0.28em] inline-block size-[0.92em] rounded-[0.18em] object-contain align-[-0.12em]"
        />
      )}
      {children}
    </a>
  )
}
