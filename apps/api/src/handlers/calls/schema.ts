// eventCursor keeps a valid Last-Event-ID and drops anything else so the client starts fresh.
export const eventCursor = (value: string | undefined): string | undefined =>
  value !== undefined && /^\d+-\d+$/.test(value) ? value : undefined;
