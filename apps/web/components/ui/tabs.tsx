"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"

import { cn } from "@/lib/utils"
import { focusRing } from "@/lib/styles"

const links = [
  { href: "/", label: "Introduction" },
  { href: "/documentation", label: "Documentation" },
]

export function Tabs({ className }: { className?: string }) {
  const pathname = usePathname()

  return (
    <nav aria-label="Site" className={cn("flex gap-4", className)}>
      {links.map(({ href, label }) => (
        <Link
          key={href}
          href={href}
          aria-current={pathname === href ? "page" : undefined}
          className={cn(
            "hover:text-ink aria-[current=page]:text-ink",
            focusRing
          )}
        >
          {label}
        </Link>
      ))}
    </nav>
  )
}
