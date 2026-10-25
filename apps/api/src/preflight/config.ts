import { Config, Effect } from "effect";

const countries = ["US"] as const;
const territories = ["AS", "GU", "MP", "PR", "VI"] as const;
const voiceTypes = ["landline", "mobile", "fixedVoip", "nonFixedVoip"] as const;

const list = (
  key: string,
  defaults: string[],
  supported: readonly string[],
  allowEmpty = false,
) =>
  Config.string(key).pipe(
    Config.withDefault(defaults.join(",")),
    Config.map((s) => [
      ...new Set(
        s
          .split(",")
          .map((v) => v.trim())
          .filter(Boolean),
      ),
    ]),
    Config.validate({
      message: `${key} must contain ${supported.join(", ")}${allowEmpty ? " or be empty" : " (at least one)"}`,
      validation: (values) =>
        (allowEmpty || values.length > 0) &&
        values.every((v) => supported.includes(v)),
    }),
  );

export const preflightConfig = Config.all({
  countries: list("RINGBACK_ALLOWED_COUNTRIES", [...countries], countries),
  territories: list("RINGBACK_ALLOWED_US_TERRITORIES", [], territories, true),
  lineTypes: list("RINGBACK_ALLOWED_LINE_TYPES", [...voiceTypes], voiceTypes),
  allowTollFree: Config.boolean("RINGBACK_ALLOW_NANP_TOLL_FREE").pipe(
    Config.withDefault(false),
  ),
  // Additional carrier-identified high-risk ranges; these can only restrict calling.
  blockedPrefixes: Config.string("RINGBACK_BLOCKED_PHONE_PREFIXES").pipe(
    Config.withDefault(""),
    Config.map((s) =>
      s
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean),
    ),
    Config.validate({
      message: "RINGBACK_BLOCKED_PHONE_PREFIXES must contain E.164 prefixes",
      validation: (values) => values.every((v) => /^\+[1-9]\d{0,14}$/.test(v)),
    }),
  ),
});

export class PreflightConfig extends Effect.Service<PreflightConfig>()(
  "api/PreflightConfig",
  {
    effect: preflightConfig,
  },
) {}
