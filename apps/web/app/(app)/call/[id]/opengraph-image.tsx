import { openGraphImage } from "@/lib/open-graph-image"

export { alt, contentType, size } from "@/lib/open-graph-image"

export default async function Image({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const title = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id)
    ? `Call ${id.slice(0, 8)}`
    : "Call"
  return openGraphImage(title, "corbyn.ai")
}
