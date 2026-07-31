import { HttpRouter, HttpServerResponse } from "@effect/platform";
import { callsFeed, callsSnapshot } from "./handlers/calls.js";
import { turnsSnapshot } from "./handlers/turns.js";

export const router = HttpRouter.empty.pipe(
  HttpRouter.get("/health", HttpServerResponse.json({ status: "ok" })),
  HttpRouter.get("/calls", callsSnapshot),
  HttpRouter.get("/calls/events", callsFeed),
  HttpRouter.get("/calls/:room/turns", turnsSnapshot),
);
