import { createServer } from "node:http";
import { HttpMiddleware, HttpServer } from "@effect/platform";
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node";
import { Config, Layer } from "effect";
import { CallFeed } from "./pipeline/feed.js";
import { MaterializerLive } from "./pipeline/materializer.js";
import { MongoClient } from "./clients/mongo.js";
import { RedisClient } from "./clients/redis.js";
import { router } from "./router.js";

const ServerLive = NodeHttpServer.layerConfig(() => createServer(), {
  port: Config.integer("PORT").pipe(Config.withDefault(3001)),
});

const HttpLive = router.pipe(
  HttpServer.serve(HttpMiddleware.logger),
  HttpServer.withLogAddress,
  Layer.provide(ServerLive),
);

const AppLive = Layer.mergeAll(HttpLive, MaterializerLive).pipe(
  Layer.provide(
    Layer.mergeAll(RedisClient.Default, MongoClient.Default, CallFeed.Default),
  ),
);

NodeRuntime.runMain(Layer.launch(AppLive));
