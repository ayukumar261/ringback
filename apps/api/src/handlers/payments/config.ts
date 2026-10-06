import { Config, Effect } from "effect";
import { environmentConfig } from "../../environment.js";

// positive reads a positive whole-number setting.
const positive = (key: string, value: number) =>
  Config.integer(key).pipe(
    Config.withDefault(value),
    Config.validate({
      message: `${key} must be a positive safe integer`,
      validation: (n) => Number.isSafeInteger(n) && n > 0,
    }),
  );

// publicUrl reads a plain http or https base URL without a trailing slash.
const publicUrl = (key: string, fallback: string) =>
  Config.string(key).pipe(
    Config.withDefault(fallback),
    Config.validate({
      message: `${key} must be HTTP(S), without credentials, query, or fragment`,
      validation: (s) => {
        try {
          const u = new URL(s);
          return (
            ["http:", "https:"].includes(u.protocol) &&
            !u.username &&
            !u.password &&
            !u.search &&
            !u.hash
          );
        } catch {
          return false;
        }
      },
    }),
    Config.map((s) => s.replace(/\/+$/, "")),
  );

// paymentConfig is the price, public URLs, and environment for paid calls.
export const paymentConfig = Config.all({
  amount: positive("RINGBACK_CALL_PRICE_CENTS", 50),
  currency: Config.string("RINGBACK_CALL_CURRENCY").pipe(
    Config.withDefault("usd"),
    Config.validate({
      message: "Currency must be a lowercase three-letter code",
      validation: (s) => /^[a-z]{3}$/.test(s),
    }),
  ),
  publicApiUrl: publicUrl("RINGBACK_PUBLIC_API_URL", "http://localhost:3001"),
  publicWebUrl: publicUrl("RINGBACK_PUBLIC_WEB_URL", "http://localhost:3000"),
  environment: environmentConfig,
  requireTerms: Config.boolean("RINGBACK_REQUIRE_TERMS").pipe(
    Config.withDefault(false),
  ),
});

// PaymentConfig is the validated payments settings.
export class PaymentConfig extends Effect.Service<PaymentConfig>()(
  "api/PaymentConfig",
  {
    effect: paymentConfig,
  },
) {}
