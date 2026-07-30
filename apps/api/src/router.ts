import { HttpRouter, HttpServerResponse } from "@effect/platform";
import { feed } from "./handlers/calls.js";

export const router = HttpRouter.empty.pipe(
  HttpRouter.get("/health", HttpServerResponse.json({ status: "ok" })),
  HttpRouter.get("/calls/events", feed),
);
