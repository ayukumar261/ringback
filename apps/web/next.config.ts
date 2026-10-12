import type { NextConfig } from "next"

const nextConfig: NextConfig = {
  output: "standalone",
  async rewrites() {
    // Caddy handles /api in deployment; Next provides the same origin locally.
    const upstream =
      process.env.RINGBACK_API_UPSTREAM ?? "http://127.0.0.1:3001"
    return [{ source: "/api/:path*", destination: `${upstream}/:path*` }]
  },
}

export default nextConfig
