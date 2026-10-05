// ByteRange is the inclusive span a Range header asks for, the whole file when the header is missing or unreadable, or unsatisfiable when it starts past the end.
export type ByteRange =
  | { readonly _tag: "full" }
  | { readonly _tag: "partial"; readonly start: number; readonly end: number }
  | { readonly _tag: "unsatisfiable" };

// parseRange reads one bytes range against a file of size bytes, clamping the end to the last byte and taking a suffix range as the last n bytes.
export const parseRange = (
  header: string | undefined,
  size: number,
): ByteRange => {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header?.trim() ?? "");
  const first = match?.[1] ?? "";
  const last = match?.[2] ?? "";
  if (match === null || (first === "" && last === "")) return { _tag: "full" };
  if (first !== "" && last !== "" && Number(first) > Number(last)) {
    return { _tag: "full" };
  }
  const start = first === "" ? Math.max(size - Number(last), 0) : Number(first);
  const end =
    first === "" || last === "" ? size - 1 : Math.min(Number(last), size - 1);
  return start >= size
    ? { _tag: "unsatisfiable" }
    : { _tag: "partial", start, end };
};
