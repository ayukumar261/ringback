import { Effect } from "effect";
import type { MongoClient } from "../../clients/mongo.js";
import { TurnsError } from "./errors.js";
import { encodeTurnSnapshots } from "./schema.js";

// listTurns reads one call's transcript oldest-first and encodes it for the wire.
export const listTurns = (mongo: MongoClient, room: string) =>
  Effect.gen(function* () {
    const docs = yield* Effect.tryPromise({
      try: () =>
        mongo.turns
          .find({ room }, { projection: { _id: 0 }, sort: { seq: 1 } })
          .toArray(),
      catch: () => new TurnsError({ code: "internal" }),
    });
    return yield* encodeTurnSnapshots(docs).pipe(
      Effect.mapError(() => new TurnsError({ code: "internal" })),
    );
  });
