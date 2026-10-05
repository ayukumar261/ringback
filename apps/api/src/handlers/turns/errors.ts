import { Data, Effect } from "effect";

// TurnsError is a failed transcript read, carrying the error code the api responds with.
export class TurnsError extends Data.TaggedError("TurnsError")<{
  code: "internal";
}> {
  override get message() {
    return this.code;
  }
}

// logTurnsError logs only the error code so raw errors and stored content stay out of logs.
export const logTurnsError = (error: unknown) =>
  Effect.logError("turns: operation failed").pipe(
    Effect.annotateLogs({
      code: error instanceof TurnsError ? error.code : "internal",
    }),
  );
