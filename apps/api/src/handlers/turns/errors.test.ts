import { Effect, Logger } from "effect";
import { describe, expect, it } from "vitest";
import { TurnsError, logTurnsError } from "./errors.js";

describe("turns diagnostics", () => {
  it("logs known failure codes with request context", async () => {
    const logs: unknown[] = [];
    const logger = Logger.make((entry) => {
      logs.push(entry);
    });
    await Effect.runPromise(
      logTurnsError(new TurnsError({ code: "internal" })).pipe(
        Effect.annotateLogs({ requestId: "request-test" }),
        Effect.provide(Logger.replace(Logger.defaultLogger, logger)),
      ),
    );
    expect(JSON.stringify(logs)).toContain("internal");
    expect(JSON.stringify(logs)).toContain("request-test");
  });

  it("does not log raw unexpected errors or their causes", async () => {
    const logs: unknown[] = [];
    const logger = Logger.make((entry) => {
      logs.push(entry);
    });
    await Effect.runPromise(
      logTurnsError(
        new Error("private transcript and credentials", {
          cause: "private filesystem path",
        }),
      ).pipe(Effect.provide(Logger.replace(Logger.defaultLogger, logger))),
    );
    const text = JSON.stringify(logs);
    expect(text).toContain("internal");
    expect(text).not.toContain("private");
  });
});
