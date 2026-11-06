import type { Metadata } from "next"
import { Geist_Mono, Inter } from "next/font/google"

import "./globals.css"
import { cn } from "@/lib/utils"

// Pages leave openGraph unset, so each inherits this one and Next fills og:title and og:description from the page's own.
export const metadata: Metadata = {
  metadataBase: new URL("https://corbyn.ai"),
  openGraph: { siteName: "Corbyn AI", type: "website" },
}

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-sans",
})

const fontMono = Geist_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
})

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    // Website pages glide to in-page links; the app keeps instant scrolling.
    // data-scroll-behavior keeps page changes instant where pages scroll smoothly.
    <html
      lang="en"
      data-scroll-behavior="smooth"
      suppressHydrationWarning
      className={cn(
        "bg-background antialiased motion-safe:has-[[data-website]]:scroll-smooth",
        // Extend the page's background into overscroll and Safari's edge fades.
        "has-[[data-website]]:bg-paper has-[[data-website]]:scheme-light-dark!",
        "has-[[data-call-dashboard]]:bg-[#fcfcfc] [&.dark:has([data-call-dashboard])]:bg-[#141414]",
        fontMono.variable,
        "font-sans",
        inter.variable
      )}
    >
      <body className="bg-inherit">{children}</body>
    </html>
  )
}
