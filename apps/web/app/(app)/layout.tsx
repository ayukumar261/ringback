import type { ReactNode } from "react"

import { ThemeProvider } from "@/components/theme-provider"
import { TooltipProvider } from "@/components/ui/tooltip"
import { SWRProvider } from "@/providers/swr-provider"

export default function AppLayout({
  children,
}: Readonly<{
  children: ReactNode
}>) {
  return (
    <ThemeProvider>
      <TooltipProvider delay={400}>
        <SWRProvider>{children}</SWRProvider>
      </TooltipProvider>
    </ThemeProvider>
  )
}
