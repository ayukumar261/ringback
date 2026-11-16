import { Config, Data, Effect, Redacted } from "effect";

// ResendError says why an email wasn't sent, without the response body.
export class ResendError extends Data.TaggedError("ResendError")<{
  code: "not_configured" | "unavailable" | `http_${number}`;
}> {
  override get message() {
    return this.code;
  }
}

// Email is one message to RESEND_TO; html is a complete document.
export interface Email {
  subject: string;
  html: string;
}

export const resendConfig = Config.all({
  apiKey: Config.redacted("RESEND_API_KEY").pipe(
    Config.withDefault(Redacted.make("")),
  ),
  to: Config.string("RESEND_TO").pipe(Config.withDefault("")),
});

export const makeResendClient = (options: {
  apiKey: Redacted.Redacted<string>;
  to: string;
  fetch?: typeof globalThis.fetch;
}) => {
  const fetch = options.fetch ?? globalThis.fetch;
  const key = Redacted.value(options.apiKey);
  return {
    // send emails RESEND_TO from corbyn@ayukumar261.com, a domain verified in Resend.
    send: (email: Email): Effect.Effect<void, ResendError> =>
      Effect.gen(function* () {
        if (!key || !options.to)
          return yield* new ResendError({ code: "not_configured" });
        yield* Effect.tryPromise({
          try: async (signal) => {
            const result = await fetch("https://api.resend.com/emails", {
              method: "POST",
              headers: {
                Authorization: `Bearer ${key}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                from: "Corbyn AI <corbyn@ayukumar261.com>",
                to: options.to,
                subject: email.subject,
                html: email.html,
              }),
              signal,
              redirect: "error",
            });
            await result.body?.cancel();
            if (!result.ok)
              throw new ResendError({ code: `http_${result.status}` });
          },
          catch: (error) =>
            error instanceof ResendError
              ? error
              : new ResendError({ code: "unavailable" }),
        }).pipe(
          Effect.timeoutFail({
            duration: "10 seconds",
            onTimeout: () => new ResendError({ code: "unavailable" }),
          }),
        );
      }),
  };
};

export class ResendClient extends Effect.Service<ResendClient>()(
  "api/ResendClient",
  {
    effect: Effect.gen(function* () {
      const config = yield* resendConfig;
      return makeResendClient(config);
    }),
  },
) {}
