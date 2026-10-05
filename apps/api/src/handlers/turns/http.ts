import { HttpRouter, HttpServerResponse } from "@effect/platform";
import { Effect } from "effect";
import { MongoClient } from "../../clients/mongo.js";
import { listTurns } from "./turns.js";
import { logTurnsError } from "./errors.js";

// turnsFor responds with room's transcript so far, which is empty for unknown rooms.
export const turnsFor = (room: string) =>
  Effect.gen(function* () {
    const mongo = yield* MongoClient;
    return yield* HttpServerResponse.json(yield* listTurns(mongo, room));
  }).pipe(
    Effect.catchAll((error) =>
      logTurnsError(error).pipe(
        Effect.zipRight(
          HttpServerResponse.json({ error: "internal" }, { status: 500 }),
        ),
      ),
    ),
  );

// turnsSnapshot serves GET /calls/:room/turns.
export const turnsSnapshot = Effect.gen(function* () {
  const params = yield* HttpRouter.params;
  return yield* turnsFor(params.room ?? "");
});
