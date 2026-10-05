import { Data, Effect } from "effect";

// CallsError is a failed calls read, carrying the error code the api responds with.
export class CallsError extends Data.TaggedError("CallsError")<{
  code: "internal";
}> {
  override get message() {
    return this.code;
  }
}

// logCallsError logs only the error code so raw errors and stored content stay out of logs.
export const logCallsError = (error: unknown) =>
  Effect.logError("calls: operation failed").pipe(
    Effect.annotateLogs({
      code: error instanceof CallsError ? error.code : "internal",
    }),
  );
