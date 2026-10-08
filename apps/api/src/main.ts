import { createServer } from "node:http";
import { HttpMiddleware, HttpServer } from "@effect/platform";
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node";
import { Config, Effect, Layer } from "effect";
import { CallFeed } from "./pipeline/feed.js";
import { MaterializerLive } from "./pipeline/materializer.js";
import { LiveKitClient } from "./clients/livekit.js";
import { MongoClient } from "./clients/mongo.js";
import { RedisClient } from "./clients/redis.js";
import { router } from "./router.js";
import { StripeClient } from "./clients/stripe.js";
import { PaymentConfig } from "./handlers/payments/config.js";
import { AudioConfig } from "./handlers/audio/config.js";
import { CallsConfig } from "./handlers/calls/config.js";
import { DispatchLive } from "./pipeline/dispatch.js";

const ServerLive = NodeHttpServer.layerConfig(() => createServer(), {
  port: Config.integer("PORT").pipe(Config.withDefault(3001)),
});

/** Origins allowed to call the API, comma-separated. */
const CorsOrigins = Config.string("CORS_ORIGINS").pipe(
  Config.withDefault("http://localhost:3000"),
  Config.map((origins) => origins.split(",").map((origin) => origin.trim())),
);

const HttpLive = Layer.unwrapEffect(
  Effect.map(CorsOrigins, (allowedOrigins) =>
    router.pipe(
      HttpMiddleware.cors({
        allowedOrigins,
        allowedMethods: ["GET", "POST"],
        // EventSource sends Last-Event-ID on resume, and browsers send the other two with POST /call
        allowedHeaders: ["Last-Event-ID", "Content-Type", "Idempotency-Key"],
        maxAge: 3600,
      }),
      HttpServer.serve(HttpMiddleware.logger),
      HttpServer.withLogAddress,
    ),
  ),
).pipe(Layer.provide(ServerLive));

const AppLive = Layer.mergeAll(HttpLive, MaterializerLive, DispatchLive).pipe(
  Layer.provide(
    Layer.mergeAll(
      PaymentConfig.Default,
      AudioConfig.Default,
      CallsConfig.Default,
    ),
  ),
  Layer.provide(
    Layer.mergeAll(
      RedisClient.Default,
      MongoClient.Default,
      LiveKitClient.Default,
      CallFeed.Default,
      StripeClient.Default,
    ),
  ),
);

NodeRuntime.runMain(Layer.launch(AppLive));
