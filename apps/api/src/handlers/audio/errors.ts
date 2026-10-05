import { Data, Effect } from "effect";

// AudioError is a failed recording read, carrying the error code the api responds with.
export class AudioError extends Data.TaggedError("AudioError")<{
  code: "not_found" | "unavailable" | "internal";
}> {
  override get message() {
    return this.code;
  }
}

// logAudioError logs only the error code so raw errors and stored content stay out of logs.
export const logAudioError = (error: unknown) =>
  Effect.logError("audio: operation failed").pipe(
    Effect.annotateLogs({
      code: error instanceof AudioError ? error.code : "internal",
    }),
  );
