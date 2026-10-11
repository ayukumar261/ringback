import type { ReactNode } from "react"

import { ThemeProvider } from "@/components/theme-provider"
import { SWRProvider } from "@/providers/swr-provider"

export default function AppLayout({
  children,
}: Readonly<{
  children: ReactNode
}>) {
  return (
    <ThemeProvider>
      <SWRProvider>{children}</SWRProvider>
    </ThemeProvider>
  )
}
