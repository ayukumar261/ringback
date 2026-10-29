import { Config, Data, Effect, Redacted, Schema } from "effect";

// ElevenLabsError says why a conversation couldn't be read, without the response body.
export class ElevenLabsError extends Data.TaggedError("ElevenLabsError")<{
  code:
    | "not_configured"
    | "unavailable"
    | "invalid_response"
    | `http_${number}`;
}> {
  override get message() {
    return this.code;
  }
}

// Conversation is the part of an ElevenLabs conversation that prices it.
export const Conversation = Schema.Struct({
  status: Schema.String,
  metadata: Schema.optionalWith(
    Schema.Struct({
      cost_fiat: Schema.optionalWith(
        Schema.NullOr(Schema.Finite.pipe(Schema.nonNegative())),
        { default: () => null },
      ),
    }),
    { default: () => ({ cost_fiat: null }) },
  ),
});
export type Conversation = typeof Conversation.Type;

export const elevenLabsConfig = Config.all({
  apiKey: Config.redacted("ELEVENLABS_API_KEY").pipe(
    Config.withDefault(Redacted.make("")),
  ),
});

export const makeElevenLabsClient = (options: {
  apiKey: Redacted.Redacted<string>;
  fetch?: typeof globalThis.fetch;
}) => {
  const fetch = options.fetch ?? globalThis.fetch;
  const key = Redacted.value(options.apiKey);
  return {
    getConversation: (
      id: string,
    ): Effect.Effect<Conversation, ElevenLabsError> =>
      Effect.gen(function* () {
        if (!key) return yield* new ElevenLabsError({ code: "not_configured" });
        const response = yield* Effect.tryPromise({
          try: async (signal) => {
            const result = await fetch(
              new URL(
                `https://api.elevenlabs.io/v1/convai/conversations/${encodeURIComponent(id)}`,
              ),
              { headers: { "xi-api-key": key }, signal, redirect: "error" },
            );
            if (!result.ok) {
              await result.body?.cancel();
              throw new ElevenLabsError({ code: `http_${result.status}` });
            }
            return result.json() as Promise<unknown>;
          },
          catch: (error) =>
            error instanceof ElevenLabsError
              ? error
              : new ElevenLabsError({ code: "unavailable" }),
        }).pipe(
          Effect.timeoutFail({
            duration: "10 seconds",
            onTimeout: () => new ElevenLabsError({ code: "unavailable" }),
          }),
        );
        return yield* Schema.decodeUnknown(Conversation)(response).pipe(
          Effect.mapError(
            () => new ElevenLabsError({ code: "invalid_response" }),
          ),
        );
      }),
  };
};

export class ElevenLabsClient extends Effect.Service<ElevenLabsClient>()(
  "api/ElevenLabsClient",
  {
    effect: Effect.gen(function* () {
      const config = yield* elevenLabsConfig;
      return makeElevenLabsClient(config);
    }),
  },
) {}
