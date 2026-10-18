import { Children, isValidElement, type ReactNode } from "react"
import type { MDXComponents } from "mdx/types"

import { Code } from "@/components/ui/code"
import { Link } from "@/components/ui/link"
import {
  focusRing,
  listItem,
  orderedList,
  paragraph,
  unorderedList,
} from "@/lib/styles"
import { cn } from "@/lib/utils"

function textContent(children: ReactNode): string {
  return Children.toArray(children)
    .map((child): string => {
      if (typeof child === "string" || typeof child === "number") {
        return String(child)
      }
      if (isValidElement<{ children?: ReactNode }>(child)) {
        return textContent(child.props.children)
      }
      return ""
    })
    .join("")
}

const components = {
  a: Link,
  blockquote: (props) => (
    <blockquote
      {...props}
      className="my-6 border-l-2 border-rule pl-4.5 text-[14px] text-ink-muted [&>p:last-child]:mb-0"
    />
  ),
  // Inline code only; code blocks render their own <code> inside `pre` below.
  code: (props) => (
    <code
      {...props}
      className="rounded-[4px] border border-rule bg-code px-1 py-px font-mono text-[0.83em] wrap-anywhere"
    />
  ),
  h1: (props) => (
    <h1
      {...props}
      className="mb-7 text-[20px] leading-normal font-semibold tracking-[-0.035em]"
    />
  ),
  h2: ({ children, ...props }) => (
    <h2
      id={textContent(children)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")}
      {...props}
      className="mt-10 mb-3.5 scroll-mt-8 leading-[1.6] font-semibold"
    >
      {children}
    </h2>
  ),
  h3: (props) => (
    <h3
      {...props}
      className="mt-8 mb-3 scroll-mt-8 text-[14px] leading-[1.6] font-semibold"
    />
  ),
  li: (props) => <li {...props} className={listItem} />,
  ol: (props) => <ol {...props} className={orderedList} />,
  p: (props) => <p {...props} className={paragraph} />,
  pre: ({ children, ...props }) => {
    const code = Children.only(children)
    const { className, children: source } = isValidElement<{
      className?: string
      children?: ReactNode
    }>(code)
      ? code.props
      : {}
    const language = className?.match(/language-(\w+)/)?.[1]

    return (
      <Code
        text={textContent(source).replace(/\n$/, "")}
        language={language}
      >
        <pre
          tabIndex={0}
          aria-label={`${language || "Code"} example`}
          {...props}
          className={cn(
            "overflow-x-auto p-4.5 font-mono text-[12px] leading-[1.85] [tab-size:2]",
            focusRing
          )}
        >
          <code className={className}>{source}</code>
        </pre>
      </Code>
    )
  },
  strong: (props) => <strong {...props} className="font-semibold" />,
  ul: (props) => <ul {...props} className={unorderedList} />,
} satisfies MDXComponents

export function useMDXComponents(): MDXComponents {
  return components
}
