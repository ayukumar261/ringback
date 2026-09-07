import { HttpRouter, HttpServerResponse } from "@effect/platform";
import { audioSnapshot } from "./handlers/audio.js";
import { callsFeed, callsSnapshot, placeCall } from "./handlers/calls.js";
import { turnsSnapshot } from "./handlers/turns.js";

export const router = HttpRouter.empty.pipe(
  HttpRouter.get("/health", HttpServerResponse.json({ status: "ok" })),
  HttpRouter.get("/calls", callsSnapshot),
  HttpRouter.get("/calls/events", callsFeed),
  HttpRouter.get("/calls/:room/turns", turnsSnapshot),
  HttpRouter.get("/calls/:room/audio", audioSnapshot),
  HttpRouter.post("/calls", placeCall),
);
