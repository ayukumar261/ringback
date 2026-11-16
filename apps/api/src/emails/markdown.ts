// Email versions of the website's Markdown elements. The inline styles copy the
// Tailwind classes in apps/web/mdx-components.tsx, apps/web/lib/styles.ts, and
// the (website) layout, so change them together.

// Html is markup to insert as is. Strings are text and get escaped.
export class Html {
  constructor(readonly markup: string) {}
}

// Content is text, markup, or a list of either.
export type Content = string | Html | Content[];

const render = (content: Content): string =>
  content instanceof Html
    ? content.markup
    : Array.isArray(content)
      ? content.map(render).join("")
      : content.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// inline mixes text with inline elements, escaping every value that isn't Html.
export const inline = (strings: TemplateStringsArray, ...values: Content[]) =>
  new Html(
    strings.reduce(
      (markup, string, i) => markup + render(values[i - 1]!) + string,
    ),
  );

const element = (tag: string, style: string, content: Content) =>
  new Html(`<${tag} style="${style}">${render(content)}</${tag}>`);

const sans =
  "Inter,ui-sans-serif,system-ui,-apple-system,'Segoe UI',Helvetica,Arial,sans-serif";
const mono =
  "'Geist Mono',ui-monospace,SFMono-Regular,Menlo,Consolas,monospace";

export const h1 = (content: Content) =>
  element(
    "h1",
    "margin:0 0 28px;font-size:20px;line-height:1.5;font-weight:600;letter-spacing:-0.035em",
    content,
  );

export const p = (content: Content) => element("p", "margin:0 0 18px", content);

export const ul = (items: Content[]) =>
  element(
    "ul",
    "margin:16px 0 24px;padding-left:22px;list-style-type:disc",
    items.map((item) =>
      element("li", "margin:0 0 14px;padding-left:6px", item),
    ),
  );

export const strong = (content: Content) =>
  element("strong", "font-weight:600", content);

export const code = (content: Content) =>
  element(
    "code",
    `border:1px solid #e7e7e7;border-radius:4px;background:#f5f5f5;padding:1px 4px;font-family:${mono};font-size:0.83em;overflow-wrap:anywhere`,
    content,
  );

// pre is a captioned code block without the copy button. It wraps long lines
// instead of scrolling them like the website does.
export const pre = (caption: string, text: string) =>
  element(
    "div",
    "margin:22px 0;border:1px solid #e7e7e7;border-radius:8px;background:#f5f5f5;overflow:hidden",
    [
      element(
        "div",
        `padding:5px 10px 5px 18px;border-bottom:1px solid #e7e7e7;font-family:${mono};font-size:11px;line-height:32px;color:#707070`,
        caption,
      ),
      element(
        "pre",
        `margin:0;padding:18px;font-family:${mono};font-size:12px;line-height:1.85;tab-size:2;white-space:pre-wrap;overflow-wrap:anywhere`,
        text,
      ),
    ],
  );

// page wraps content in the website's 640px column under a "Corbyn AI"
// header. It keeps the light palette, since most email clients ignore
// prefers-color-scheme.
export const page = (content: Content) =>
  '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
  '<meta name="viewport" content="width=device-width, initial-scale=1">' +
  '<meta name="color-scheme" content="light"></head>' +
  '<body style="margin:0;background:#fcfcfc">' +
  render(
    element(
      "div",
      `max-width:640px;margin:0 auto;padding:32px 24px 48px;font-family:${sans};font-size:15px;line-height:1.8;color:#252525;-webkit-font-smoothing:antialiased`,
      [
        element(
          "div",
          "margin:0 0 36px;font-size:12px;font-weight:600;letter-spacing:-0.025em",
          "Corbyn AI",
        ),
        content,
      ],
    ),
  ) +
  "</body></html>";
