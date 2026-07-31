import { HttpRouter, HttpServerResponse } from "@effect/platform";
import { Effect, Schema } from "effect";
import { MongoClient } from "../clients/mongo.js";

// TurnSnapshot encodes a TurnDoc into the SSE wire dialect: snake_case, unix-ms.
export const TurnSnapshot = Schema.Struct({
  room: Schema.String,
  seq: Schema.Number,
  role: Schema.Literal("caller", "agent"),
  text: Schema.String,
  at: Schema.DateFromNumber,
});

const encodeSnapshots = Schema.encode(Schema.Array(TurnSnapshot));

// listTurns reads one call's transcript oldest-first and encodes it for the wire.
export const listTurns = (mongo: MongoClient, room: string) =>
  Effect.gen(function* () {
    const docs = yield* Effect.tryPromise(() =>
      mongo.turns
        .find({ room }, { projection: { _id: 0 }, sort: { seq: 1 } })
        .toArray(),
    );
    return yield* encodeSnapshots(docs);
  });

// turnsFor responds with room's transcript so far; unknown rooms are just empty.
export const turnsFor = (room: string) =>
  Effect.gen(function* () {
    const mongo = yield* MongoClient;
    return yield* HttpServerResponse.json(yield* listTurns(mongo, room));
  }).pipe(
    Effect.catchAll((error) =>
      Effect.logError("turns: snapshot failed", error).pipe(
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
