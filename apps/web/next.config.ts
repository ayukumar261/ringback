import createMDX from "@next/mdx"
import type { NextConfig } from "next"

const nextConfig: NextConfig = {
  output: "standalone",
  async rewrites() {
    // Caddy handles /api in deployment; Next provides the same origin locally.
    const upstream =
      process.env.RINGBACK_API_UPSTREAM ?? "http://127.0.0.1:3001"
    return [{ source: "/api/:path*", destination: `${upstream}/:path*` }]
  },
  async headers() {
    return [
      {
        source: "/call/:path*",
        headers: [
          { key: "Cache-Control", value: "private, no-store" },
          { key: "X-Robots-Tag", value: "noindex, nofollow, noarchive" },
          { key: "Referrer-Policy", value: "no-referrer" },
        ],
      },
    ]
  },
}

const withMDX = createMDX({
  options: {
    rehypePlugins: ["rehype-highlight"],
  },
})

export default withMDX(nextConfig)
