import { basename, join } from "node:path";
import { HttpRouter, HttpServerResponse } from "@effect/platform";
import { Config, Effect, Option } from "effect";
import { MongoClient } from "../clients/mongo.js";

// AudioDir is the directory the worker writes recordings into, and leaving it unset disables the route.
const AudioDir = Config.option(Config.string("AUDIO_DIR"));

// findAudio reads the recording's file name off the call doc, undefined when the call has none.
export const findAudio = (mongo: MongoClient, room: string) =>
  Effect.tryPromise(() =>
    mongo.calls.findOne({ room }, { projection: { _id: 0, audio: 1 } }),
  ).pipe(
    Effect.map((doc) =>
      doc?.audio === undefined || doc.audio === "" ? undefined : doc.audio,
    ),
  );

// audioPath places the file under dir, keeping only the basename so the doc can never point outside it.
export const audioPath = (dir: string, name: string): string =>
  join(dir, basename(name));

// audioFor streams room's recording as wav, 404 when the call has no audio or the file is gone.
export const audioFor = (room: string) =>
  Effect.gen(function* () {
    const dir = yield* AudioDir;
    if (Option.isNone(dir)) {
      yield* Effect.logWarning("audio: AUDIO_DIR unset, refusing to serve");
      return yield* HttpServerResponse.json({ error: "disabled" }, { status: 503 });
    }
    const mongo = yield* MongoClient;
    const name = yield* findAudio(mongo, room);
    if (name === undefined) {
      return yield* HttpServerResponse.json(
        { error: "not found" },
        { status: 404 },
      );
    }
    return yield* HttpServerResponse.file(audioPath(dir.value, name), {
      contentType: "audio/wav",
    }).pipe(
      Effect.catchIf(
        (e) => e._tag === "SystemError" && e.reason === "NotFound",
        () =>
          Effect.logWarning(`audio: ${room} names a missing file`).pipe(
            Effect.zipRight(
              HttpServerResponse.json({ error: "not found" }, { status: 404 }),
            ),
          ),
      ),
    );
  }).pipe(
    Effect.catchAll((error) =>
      Effect.logError("audio: serve failed", error).pipe(
        Effect.zipRight(
          HttpServerResponse.json({ error: "internal" }, { status: 500 }),
        ),
      ),
    ),
  );

// audioSnapshot serves GET /calls/:room/audio.
export const audioSnapshot = Effect.gen(function* () {
  const params = yield* HttpRouter.params;
  return yield* audioFor(params.room ?? "");
});
