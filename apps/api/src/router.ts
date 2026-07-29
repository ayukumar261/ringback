import { HttpRouter, HttpServerResponse } from "@effect/platform";

export const router = HttpRouter.empty.pipe(
  HttpRouter.get("/", HttpServerResponse.text("ringback api")),
  HttpRouter.get("/health", HttpServerResponse.json({ status: "ok" })),
);
