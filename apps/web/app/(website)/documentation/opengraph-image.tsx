import { openGraphImage } from "@/lib/open-graph-image"

export { alt, contentType, size } from "@/lib/open-graph-image"

export default function Image() {
  return openGraphImage("Documentation", "corbyn.ai/documentation")
}
