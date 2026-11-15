import { Data } from "effect";

export class PreflightError extends Data.TaggedError("PreflightError")<{
  code:
    | "invalid_destination"
    | "unsupported_country"
    | "blocked_number"
    | "unsupported_line_type"
    | "line_type_unavailable"
    | "lookup_unavailable"
    | "lookup_access_denied"
    | "daily_call_limit"
    | "call_limit_unavailable";
}> {
  override get message() {
    if (this.code === "daily_call_limit")
      return "This destination has reached its limit of 3 calls in the last 24 hours. Try again later.";
    if (this.code === "call_limit_unavailable")
      return "The destination call limit could not be checked. Try again later.";
    return this.code;
  }
}

export const preflightStatus = (error: PreflightError): 422 | 429 | 503 =>
  error.code === "daily_call_limit"
    ? 429
    : [
          "line_type_unavailable",
          "lookup_unavailable",
          "lookup_access_denied",
          "call_limit_unavailable",
        ].includes(error.code)
      ? 503
      : 422;
