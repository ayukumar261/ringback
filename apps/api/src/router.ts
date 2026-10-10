import { HttpRouter, HttpServerResponse } from "@effect/platform";
import { audioSnapshot } from "./handlers/audio/http.js";
import {
  callsFeed,
  callsSnapshot,
  callSnapshot,
  callTurns,
  callAudio,
} from "./handlers/calls/http.js";
import { turnsSnapshot } from "./handlers/turns/http.js";
import { createCall } from "./handlers/payments/http.js";
import { stripeWebhook } from "./webhooks/stripe.js";

export const router = HttpRouter.empty.pipe(
  HttpRouter.get("/health", HttpServerResponse.json({ status: "ok" })),
  HttpRouter.get("/calls", callsSnapshot),
  HttpRouter.get("/calls/events", callsFeed),
  HttpRouter.get("/calls/:room/turns", turnsSnapshot),
  HttpRouter.get("/calls/:room/audio", audioSnapshot),
  HttpRouter.post("/call", createCall),
  HttpRouter.get("/call/:id", callSnapshot),
  HttpRouter.get("/call/:id/turns", callTurns),
  HttpRouter.get("/call/:id/audio", callAudio),
  HttpRouter.post("/webhooks/stripe", stripeWebhook),
);
