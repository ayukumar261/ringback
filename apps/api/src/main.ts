import { createServer } from "node:http";
import { HttpMiddleware, HttpServer } from "@effect/platform";
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node";
import { Config, Layer } from "effect";
import { router } from "./router.js";

const ServerLive = NodeHttpServer.layerConfig(() => createServer(), {
  port: Config.integer("PORT").pipe(Config.withDefault(3001)),
});

const AppLive = router.pipe(
  HttpServer.serve(HttpMiddleware.logger),
  HttpServer.withLogAddress,
  Layer.provide(ServerLive),
);

NodeRuntime.runMain(Layer.launch(AppLive));
