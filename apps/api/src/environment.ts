import { Config } from "effect";

// Environment picks Stripe Sandbox in development and live Stripe in production.
export type Environment = "development" | "production";

// environmentConfig reads NODE_ENV and defaults to development.
export const environmentConfig = Config.literal(
  "development",
  "production",
)("NODE_ENV").pipe(Config.withDefault("development"));
