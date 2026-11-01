import { Data } from "effect";

export class PreflightError extends Data.TaggedError("PreflightError")<{
  code:
    | "invalid_destination"
    | "unsupported_country"
    | "blocked_number"
    | "unsupported_line_type"
    | "line_type_unavailable"
    | "lookup_unavailable"
    | "lookup_access_denied";
}> {
  override get message() {
    return this.code;
  }
}

export const preflightStatus = (error: PreflightError): 422 | 503 =>
  [
    "line_type_unavailable",
    "lookup_unavailable",
    "lookup_access_denied",
  ].includes(error.code)
    ? 503
    : 422;
