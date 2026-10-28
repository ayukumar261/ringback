import { Decimal128 } from "mongodb";

// Money stays exact decimal text until Mongo stores it: floats drift, and
// Decimal128 can't do arithmetic in JavaScript.
const parts = (value: string): [bigint, number] => {
  const match = /^([+-]?)(\d+)(?:\.(\d*))?(?:e([+-]?\d+))?$/i.exec(value);
  if (!match) throw new Error("invalid_decimal");
  const scale = (match[3]?.length ?? 0) - Number(match[4] ?? 0);
  if (!Number.isSafeInteger(scale) || Math.abs(scale) > 6200)
    throw new Error("invalid_decimal");
  return [
    BigInt(`${match[1] === "-" ? "-" : ""}${match[2]}${match[3] ?? ""}`),
    scale,
  ];
};

const format = (coefficient: bigint, scale: number): string => {
  if (coefficient === 0n) return "0";
  if (scale < 0) return `${coefficient}${"0".repeat(-scale)}`;
  const sign = coefficient < 0n ? "-" : "";
  const digits = (coefficient < 0n ? -coefficient : coefficient)
    .toString()
    .padStart(scale + 1, "0");
  return scale === 0
    ? `${sign}${digits}`
    : `${sign}${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
};

// decimal converts exact decimal text to Mongo's Decimal128.
export const decimal = (value: string): Decimal128 => {
  parts(value);
  return Decimal128.fromString(value);
};

// negate flips the sign without rounding.
export const negate = (value: string): string => {
  const [n, s] = parts(value);
  return format(-n, s);
};

// dollarsToCents moves the decimal point, keeping fractional cents.
export const dollarsToCents = (value: string): string => {
  const [n, s] = parts(value);
  return format(n, s - 2);
};
