import { Effect } from "effect";
import { parsePhoneNumberFromString } from "libphonenumber-js/max";
import {
  TwilioClient,
  type PhoneLookup,
  type TwilioError,
} from "../clients/twilio.js";
import { MongoClient } from "../clients/mongo.js";
import { environmentConfig } from "../environment.js";
import { recordLookup, type ExpenseAttribution } from "../expenses/store.js";
import { PreflightError } from "./errors.js";

type Lookup = (
  number: string,
  onBilled?: Effect.Effect<void>,
) => Effect.Effect<PhoneLookup, TwilioError>;
type RecordLookup = (attribution: ExpenseAttribution) => Effect.Effect<void>;

// NANP toll-free is shared by multiple countries; check it independently of country.
const tollFree = /^\+1(?:800|833|844|855|866|877|888)/;
const voiceTypes = ["landline", "mobile", "fixedVoip", "nonFixedVoip"];

export const makePreflight = (
  lookup: Lookup,
  record: RecordLookup = () => Effect.void,
) => ({
  check: (
    number: string,
    attribution: ExpenseAttribution = {},
  ): Effect.Effect<PhoneLookup, PreflightError> =>
    Effect.gen(function* () {
      if (!/^\+[1-9]\d{6,14}$/.test(number))
        return yield* new PreflightError({ code: "invalid_destination" });
      // Block N11 emergency/service codes and premium/information services before Lookup.
      if (
        /^\+1(?:[2-9]11|900)/.test(number) ||
        /^\+1\d{3}(?:[2-9]11|976)/.test(number)
      ) {
        return yield* new PreflightError({ code: "blocked_number" });
      }
      if (!number.startsWith("+1"))
        return yield* new PreflightError({ code: "unsupported_country" });
      const phone = parsePhoneNumberFromString(number, { extract: false });
      if (!phone?.isValid() || phone.number !== number)
        return yield* new PreflightError({ code: "invalid_destination" });
      const sharedTollFree = tollFree.test(number);
      if (!sharedTollFree && phone.country !== "US")
        return yield* new PreflightError({ code: "unsupported_country" });
      const result = yield* lookup(number, record(attribution)).pipe(
        Effect.mapError((e) => new PreflightError({ code: e.code })),
      );
      if (!result.valid || result.number !== number)
        return yield* new PreflightError({ code: "invalid_destination" });
      if (!sharedTollFree && result.country !== "US")
        return yield* new PreflightError({ code: "unsupported_country" });
      if (result.lineTypeError !== null || result.lineType === "unknown")
        return yield* new PreflightError({ code: "line_type_unavailable" });
      if (["premium", "sharedCost"].includes(result.lineType))
        return yield* new PreflightError({ code: "blocked_number" });
      if (
        sharedTollFree
          ? result.lineType !== "tollFree"
          : !voiceTypes.includes(result.lineType)
      )
        return yield* new PreflightError({ code: "unsupported_line_type" });
      return result;
    }),
});

export class Preflight extends Effect.Service<Preflight>()("api/Preflight", {
  effect: Effect.gen(function* () {
    const client = yield* TwilioClient;
    const mongo = yield* MongoClient;
    const environment = yield* environmentConfig;
    return makePreflight(client.lookup, (attribution) =>
      recordLookup(mongo, environment, attribution),
    );
  }),
}) {}
