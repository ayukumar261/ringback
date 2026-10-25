import { Effect } from "effect";
import { parsePhoneNumberFromString } from "libphonenumber-js/max";
import {
  TwilioClient,
  type PhoneLookup,
  type TwilioError,
} from "../clients/twilio.js";
import { PreflightConfig } from "./config.js";
import { PreflightError } from "./errors.js";

type Settings = Omit<PreflightConfig, "_tag">;
type Lookup = (number: string) => Effect.Effect<PhoneLookup, TwilioError>;

// NANP toll-free is shared by multiple countries; it has its own opt-in policy.
const tollFree = /^\+1(?:800|833|844|855|866|877|888)/;

export const makePreflight = (lookup: Lookup, settings: Settings) => ({
  check: (number: string): Effect.Effect<PhoneLookup, PreflightError> =>
    Effect.gen(function* () {
      if (!/^\+[1-9]\d{6,14}$/.test(number))
        return yield* new PreflightError({ code: "invalid_destination" });
      // Block N11 emergency/service codes and premium/information services before Lookup.
      if (
        /^\+1(?:[2-9]11|900)/.test(number) ||
        /^\+1\d{3}(?:[2-9]11|976)/.test(number) ||
        settings.blockedPrefixes.some((prefix) => number.startsWith(prefix))
      ) {
        return yield* new PreflightError({ code: "blocked_number" });
      }
      if (!number.startsWith("+1"))
        return yield* new PreflightError({ code: "unsupported_country" });
      const phone = parsePhoneNumberFromString(number, { extract: false });
      if (!phone?.isValid() || phone.number !== number)
        return yield* new PreflightError({ code: "invalid_destination" });
      const sharedTollFree = tollFree.test(number);
      if (sharedTollFree && !settings.allowTollFree)
        return yield* new PreflightError({ code: "toll_free_not_allowed" });
      const allowed = (country: string | undefined | null) =>
        country !== null &&
        country !== undefined &&
        (settings.countries.includes(country) ||
          settings.territories.includes(country));
      if (!sharedTollFree && !allowed(phone.country))
        return yield* new PreflightError({ code: "unsupported_country" });
      const result = yield* lookup(number).pipe(
        Effect.mapError((e) => new PreflightError({ code: e.code })),
      );
      if (!result.valid || result.number !== number)
        return yield* new PreflightError({ code: "invalid_destination" });
      if (
        !sharedTollFree &&
        (!allowed(result.country) || result.country !== phone.country)
      )
        return yield* new PreflightError({ code: "unsupported_country" });
      if (result.lineTypeError !== null || result.lineType === "unknown")
        return yield* new PreflightError({ code: "line_type_unavailable" });
      if (["premium", "sharedCost"].includes(result.lineType))
        return yield* new PreflightError({ code: "blocked_number" });
      if (
        sharedTollFree
          ? result.lineType !== "tollFree"
          : !settings.lineTypes.includes(result.lineType)
      )
        return yield* new PreflightError({ code: "unsupported_line_type" });
      return result;
    }),
});

export class Preflight extends Effect.Service<Preflight>()("api/Preflight", {
  effect: Effect.gen(function* () {
    const client = yield* TwilioClient;
    const settings = yield* PreflightConfig;
    return makePreflight(client.lookup, settings);
  }),
}) {}
