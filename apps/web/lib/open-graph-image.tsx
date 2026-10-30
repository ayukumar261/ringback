import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { ImageResponse } from "next/og"

export const alt = "Corbyn AI makes phone calls for AI agents."
export const size = { width: 1200, height: 630 }
export const contentType = "image/png"

// Website pages render this at build time and call pages on request; Next copies assets/ into the standalone server for the latter.
export async function openGraphImage(title: string, address: string) {
  const font = (file: string) => readFile(join(process.cwd(), "assets", file))
  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        padding: "72px 88px",
        background: "#fcfcfc",
        color: "#252525",
        fontFamily: "Inter",
        fontSize: 30,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between" }}>
        <div style={{ fontWeight: 600, letterSpacing: "-0.025em" }}>
          Corbyn AI
        </div>
        <div style={{ color: "#707070" }}>{address}</div>
      </div>
      <div style={{ display: "flex", flexDirection: "column" }}>
        <div
          style={{
            fontFamily: "Inter Display",
            fontSize: 104,
            fontWeight: 600,
            letterSpacing: "-0.045em",
          }}
        >
          {title}
        </div>
        <div
          style={{
            marginTop: 20,
            fontSize: 32,
            color: "#707070",
            letterSpacing: "-0.01em",
          }}
        >
          Phone calls for AI agents
        </div>
      </div>
    </div>,
    {
      ...size,
      fonts: [
        { name: "Inter", data: await font("Inter-Regular.ttf"), weight: 400 },
        { name: "Inter", data: await font("Inter-SemiBold.ttf"), weight: 600 },
        {
          name: "Inter Display",
          data: await font("InterDisplay-SemiBold.ttf"),
          weight: 600,
        },
      ],
    }
  )
}
