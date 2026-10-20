import type { ComponentProps } from "react"

import { cn } from "@/lib/utils"

export function Container({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "mx-auto w-[calc(100%-3rem)] sm:w-136 md:w-152 lg:w-160",
        className
      )}
      {...props}
    />
  )
}
