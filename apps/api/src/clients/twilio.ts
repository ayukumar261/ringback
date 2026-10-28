import { createHash } from "node:crypto";
import { Config, Data, Effect, Redacted, Schema } from "effect";
import type { Redis } from "ioredis";
import { RedisClient } from "./redis.js";

export const LineType = Schema.Literal(
  "landline",
  "mobile",
  "fixedVoip",
  "nonFixedVoip",
  "personal",
  "tollFree",
  "premium",
  "sharedCost",
  "uan",
  "voicemail",
  "pager",
  "unknown",
);
export type LineType = typeof LineType.Type;

// Unknown and inaccessible data stay explicit; they never count as approval.
export const PhoneLookup = Schema.Struct({
  number: Schema.String,
  valid: Schema.Boolean,
  country: Schema.NullOr(Schema.String),
  lineType: LineType,
  lineTypeError: Schema.NullOr(Schema.Number),
  checkedAt: Schema.Number,
  expiresAt: Schema.Number,
});
export type PhoneLookup = typeof PhoneLookup.Type;

export class TwilioError extends Data.TaggedError("TwilioError")<{
  code: "lookup_unavailable" | "lookup_access_denied";
}> {
  override get message() {
    return this.code;
  }
}

// TwilioCallError says why a call couldn't be read, without Twilio's response body.
export class TwilioCallError extends Data.TaggedError("TwilioCallError")<{
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

const LookupResponse = Schema.Struct({
  phone_number: Schema.NullOr(Schema.String),
  valid: Schema.Boolean,
  country_code: Schema.optionalWith(Schema.NullOr(Schema.String), {
    default: () => null,
  }),
  line_type_intelligence: Schema.optionalWith(
    Schema.NullOr(
      Schema.Struct({
        type: Schema.optionalWith(Schema.NullOr(Schema.String), {
          default: () => null,
        }),
        error_code: Schema.optionalWith(Schema.NullOr(Schema.Number), {
          default: () => null,
        }),
      }),
    ),
    { default: () => null },
  ),
});

// TwilioCall is the part of a Calls API resource that prices a call leg.
export const TwilioCall = Schema.Struct({
  status: Schema.String,
  // Twilio reports a charge as negative decimal dollars, e.g. "-0.0085".
  price: Schema.optionalWith(
    Schema.NullOr(Schema.String.pipe(Schema.pattern(/^-?\d+(?:\.\d+)?$/))),
    { default: () => null },
  ),
  price_unit: Schema.optionalWith(Schema.NullOr(Schema.String), {
    default: () => null,
  }),
});
export type TwilioCall = typeof TwilioCall.Type;

const positive = (key: string, fallback: number, max: number) =>
  Config.integer(key).pipe(
    Config.withDefault(fallback),
    Config.validate({
      message: `${key} must be an integer between 1 and ${max}`,
      validation: (n) => Number.isInteger(n) && n > 0 && n <= max,
    }),
  );

export const twilioConfig = Config.all({
  accountSid: Config.redacted("TWILIO_ACCOUNT_SID").pipe(
    Config.withDefault(Redacted.make("")),
  ),
  authToken: Config.redacted("TWILIO_AUTH_TOKEN").pipe(
    Config.withDefault(Redacted.make("")),
  ),
  timeoutMs: positive("RINGBACK_LOOKUP_TIMEOUT_MS", 5_000, 30_000),
  cacheTtlSeconds: positive(
    "RINGBACK_LOOKUP_CACHE_TTL_SECONDS",
    86_400,
    86_400,
  ),
});

export const makeTwilioClient = (options: {
  accountSid: Redacted.Redacted<string>;
  authToken: Redacted.Redacted<string>;
  timeoutMs: number;
  cacheTtlSeconds: number;
  cache: Pick<Redis, "get" | "set">;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
}) => {
  const fetch = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const accountSid = Redacted.value(options.accountSid);
  const token = Redacted.value(options.authToken);
  const authorization = `Basic ${Buffer.from(`${accountSid}:${token}`).toString("base64")}`;
  // Account and response schema version scope cache entries; keys contain no raw numbers.
  const keyFor = (number: string) =>
    `ringback:lookup:v1:${createHash("sha256").update(`${accountSid}:${number}`).digest("hex")}`;
  return {
    // onBilled runs once Twilio has charged for fresh line-type data; cache hits are free.
    lookup: (
      number: string,
      onBilled: Effect.Effect<void> = Effect.void,
    ): Effect.Effect<PhoneLookup, TwilioError> =>
      Effect.gen(function* () {
        if (!accountSid || !token)
          return yield* new TwilioError({ code: "lookup_unavailable" });
        const key = keyFor(number);
        const cached = yield* Effect.tryPromise(() =>
          options.cache.get(key),
        ).pipe(
          Effect.timeout("250 millis"),
          Effect.orElseSucceed(() => null),
        );
        if (cached) {
          const decoded = Schema.decodeUnknownEither(
            Schema.parseJson(PhoneLookup),
          )(cached);
          if (decoded._tag === "Right") {
            const value = decoded.right;
            if (
              value.number === number &&
              value.valid &&
              value.lineType !== "unknown" &&
              value.lineTypeError === null &&
              value.checkedAt <= now() &&
              value.expiresAt > now() &&
              value.expiresAt - value.checkedAt <=
                options.cacheTtlSeconds * 1_000
            )
              return value;
          }
        }
        const response = yield* Effect.tryPromise({
          try: async (signal) => {
            const url = new URL(
              `https://lookups.twilio.com/v2/PhoneNumbers/${encodeURIComponent(number)}`,
            );
            url.searchParams.set("Fields", "line_type_intelligence");
            const result = await fetch(url, {
              headers: { Authorization: authorization },
              signal: AbortSignal.any([
                signal,
                AbortSignal.timeout(options.timeoutMs),
              ]),
              redirect: "error",
            });
            if (!result.ok) {
              await result.body?.cancel();
              throw new TwilioError({
                code: [401, 403].includes(result.status)
                  ? "lookup_access_denied"
                  : "lookup_unavailable",
              });
            }
            return result.json() as Promise<unknown>;
          },
          catch: (error) =>
            error instanceof TwilioError
              ? error
              : new TwilioError({ code: "lookup_unavailable" }),
        }).pipe(
          Effect.timeoutFail({
            duration: options.timeoutMs,
            onTimeout: () => new TwilioError({ code: "lookup_unavailable" }),
          }),
        );
        const data = yield* Schema.decodeUnknown(LookupResponse)(response).pipe(
          Effect.mapError(
            () => new TwilioError({ code: "lookup_unavailable" }),
          ),
        );
        if (data.valid && data.phone_number !== number)
          return yield* new TwilioError({ code: "lookup_unavailable" });
        if (
          data.valid &&
          data.line_type_intelligence?.type &&
          data.line_type_intelligence.error_code === null
        )
          yield* onBilled;
        const type = Schema.decodeUnknownEither(LineType)(
          data.line_type_intelligence?.type,
        );
        const checkedAt = now();
        const value: PhoneLookup = {
          number,
          valid: data.valid,
          country: data.country_code,
          lineType: type._tag === "Right" ? type.right : "unknown",
          lineTypeError: data.line_type_intelligence?.error_code ?? null,
          checkedAt,
          expiresAt: checkedAt + options.cacheTtlSeconds * 1_000,
        };
        // Don't retain missing data or access errors: approval may have just been enabled.
        if (
          value.valid &&
          value.lineType !== "unknown" &&
          value.lineTypeError === null
        ) {
          yield* Effect.tryPromise(() =>
            options.cache.set(
              key,
              JSON.stringify(value),
              "EX",
              options.cacheTtlSeconds,
            ),
          ).pipe(Effect.timeout("250 millis"), Effect.ignore);
        }
        return value;
      }),
    // getCall reads a call leg's status and price; Twilio prices it shortly after hangup.
    getCall: (sid: string): Effect.Effect<TwilioCall, TwilioCallError> =>
      Effect.gen(function* () {
        if (!accountSid || !token)
          return yield* new TwilioCallError({ code: "not_configured" });
        const response = yield* Effect.tryPromise({
          try: async (signal) => {
            const result = await fetch(
              new URL(
                `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Calls/${encodeURIComponent(sid)}.json`,
              ),
              {
                headers: { Authorization: authorization },
                signal,
                redirect: "error",
              },
            );
            if (!result.ok) {
              await result.body?.cancel();
              throw new TwilioCallError({ code: `http_${result.status}` });
            }
            return result.json() as Promise<unknown>;
          },
          catch: (error) =>
            error instanceof TwilioCallError
              ? error
              : new TwilioCallError({ code: "unavailable" }),
        }).pipe(
          Effect.timeoutFail({
            duration: "10 seconds",
            onTimeout: () => new TwilioCallError({ code: "unavailable" }),
          }),
        );
        return yield* Schema.decodeUnknown(TwilioCall)(response).pipe(
          Effect.mapError(
            () => new TwilioCallError({ code: "invalid_response" }),
          ),
        );
      }),
  };
};

export class TwilioClient extends Effect.Service<TwilioClient>()(
  "api/TwilioClient",
  {
    effect: Effect.gen(function* () {
      const config = yield* twilioConfig;
      const cache = yield* RedisClient;
      return makeTwilioClient({ ...config, cache });
    }),
  },
) {}
