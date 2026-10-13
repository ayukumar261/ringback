import { HttpRouter, HttpServerResponse } from "@effect/platform";
import { createCall } from "./handlers/payments/http.js";
import {
  bootstrapCallAccess,
  callSnapshot,
  callTurns,
  callAudio,
  callEvents,
} from "./handlers/calls/http.js";
import { stripeWebhook } from "./webhooks/stripe.js";

export const router = HttpRouter.empty.pipe(
  HttpRouter.get("/health", HttpServerResponse.json({ status: "ok" })),
  HttpRouter.post("/call", createCall),
  HttpRouter.get("/call/:id", callSnapshot),
  HttpRouter.post("/call/:id/access", bootstrapCallAccess),
  HttpRouter.get("/call/:id/turns", callTurns),
  HttpRouter.get("/call/:id/audio", callAudio),
  HttpRouter.get("/call/:id/events", callEvents),
  HttpRouter.post("/webhooks/stripe", stripeWebhook),
);
