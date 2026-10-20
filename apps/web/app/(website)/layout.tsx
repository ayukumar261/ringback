import Link from "next/link"

import { Container } from "@/components/container"
import { Tabs } from "@/components/ui/tabs"
import { focusRing, link } from "@/lib/styles"
import { cn } from "@/lib/utils"

export default function WebsiteLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    // data-website lets the root <html> scroll smoothly on these pages only.
    <div
      data-website
      id="top"
      className="min-h-svh bg-paper pt-8 pb-12 text-[15px] leading-[1.8] text-ink antialiased scheme-light-dark sm:pt-20 sm:pb-24"
    >
      <Container>
        <header className="mb-9 flex items-center justify-between gap-4 text-[12px] text-ink-muted sm:mb-12">
          <Link
            href="/"
            className={cn(
              "font-semibold tracking-[-0.025em] text-ink",
              focusRing
            )}
          >
            Corbyn AI
          </Link>
          <Tabs />
        </header>

        <main>{children}</main>

        <footer className="mt-10 flex flex-wrap items-center justify-between gap-4 border-t border-rule pt-5 text-[12px] text-ink-muted">
          <span>© {new Date().getFullYear()} Corbyn AI</span>
          <nav className="flex flex-wrap gap-2" aria-label="Legal and contact">
            <Link href="/terms-and-conditions" className={link}>
              Terms and Conditions
            </Link>
            <Link href="/privacy-policy" className={link}>
              Privacy Policy
            </Link>
            <a href="mailto:ayush@corbyn.ai" className={link}>
              ayush@corbyn.ai
            </a>
          </nav>
        </footer>
      </Container>
    </div>
  )
}
