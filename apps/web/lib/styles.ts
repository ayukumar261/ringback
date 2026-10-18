// Tailwind classes shared by article content, layouts, and UI components.

export const focusRing =
  "focus-visible:rounded-[4px] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ink"

export const link = `rounded-[6px] bg-link px-[5px] py-px box-decoration-clone transition-colors duration-120 hover:bg-link-hover motion-reduce:transition-none ${focusRing}`

export const paragraph = "mb-4.5"

export const orderedList = "mt-4 mb-6 list-decimal pl-5.5"

export const unorderedList = "mt-4 mb-6 list-disc pl-5.5"

export const listItem =
  "mb-3.5 pl-1.5 marker:font-mono marker:text-[12px] marker:text-ink-muted"
