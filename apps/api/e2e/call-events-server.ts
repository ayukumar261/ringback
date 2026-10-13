// Disposable browser-test server: the real private SSE handler with in-memory services.
// apps/web/e2e/support/servers.ts owns the address and call; Playwright passes them as env.
import { createServer } from "node:http";
import { HttpRouter, HttpServer, HttpServerResponse } from "@effect/platform";
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node";
import { Config, Effect, Layer } from "effect";
import { MongoClient } from "../src/clients/mongo.js";
import { RedisClient } from "../src/clients/redis.js";
import { CallFeed } from "../src/pipeline/feed.js";
import { CallsConfig } from "../src/handlers/calls/config.js";
import { newCallAccess } from "../src/handlers/payments/access.js";
import { callEvents } from "../src/handlers/calls/http.js";

const ServerLive = NodeHttpServer.layerConfig(() => createServer(), {
  host: Config.string("HOST"),
  port: Config.integer("PORT"),
});

const MongoLive = Layer.unwrapEffect(
  Effect.map(
    Config.all({
      id: Config.string("E2E_CALL_ID"),
      token: Config.string("E2E_CALL_TOKEN"),
    }),
    ({ id, token }) => {
      const record = {
        _id: id,
        room: `room-${id}`,
        access: newCallAccess(token, new Date()),
      };
      return Layer.succeed(MongoClient, {
        requests: {
          findOne: async ({ _id }: { _id: string }) =>
            _id === record._id ? record : null,
        },
      } as unknown as MongoClient);
    },
  ),
);

NodeRuntime.runMain(
  Layer.launch(
    HttpRouter.empty.pipe(
      HttpRouter.get("/health", HttpServerResponse.json({ status: "ok" })),
      HttpRouter.get("/call/:id/events", callEvents),
      HttpServer.serve(),
      Layer.provide(ServerLive),
      Layer.provide(
        Layer.mergeAll(
          CallFeed.Default,
          Layer.succeed(
            CallsConfig,
            CallsConfig.make({
              keepaliveMs: 15000,
              retryMs: 3000,
            }),
          ),
          MongoLive,
          Layer.succeed(RedisClient, {
            xrange: async () => [],
          } as unknown as RedisClient),
        ),
      ),
    ),
  ),
);
