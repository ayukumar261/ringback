import { Effect, Logger } from "effect";
import { describe, expect, it } from "vitest";
import { PaymentError, logPaymentFailure } from "./errors.js";

describe("payment diagnostics", () => {
  it("logs the failed operation and code with correlation IDs", async () => {
    const logs: unknown[] = [];
    const logger = Logger.make((entry) => {
      logs.push(entry);
    });
    await Effect.runPromise(
      logPaymentFailure("dispatch", "interrupted").pipe(
        Effect.annotateLogs({
          requestId: "request-test",
          sessionId: "cs_test",
        }),
        Effect.provide(Logger.replace(Logger.defaultLogger, logger)),
      ),
    );
    const text = JSON.stringify(logs);
    expect(text).toContain("interrupted");
    expect(text).toContain("request-test");
    expect(text).toContain("cs_test");
  });
  it("keeps domain failures in the typed Effect error channel", async () => {
    const error = new PaymentError({ code: "conflict" });
    expect(
      await Effect.runPromise(
        Effect.fail(error).pipe(
          Effect.catchTag("PaymentError", (e) => Effect.succeed(e.code)),
        ),
      ),
    ).toBe("conflict");
  });
});
