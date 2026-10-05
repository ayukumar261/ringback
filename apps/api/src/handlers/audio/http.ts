import {
  FileSystem,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "@effect/platform";
import { Effect, Option, Stream } from "effect";
import { MongoClient } from "../../clients/mongo.js";
import { audioPath, findAudio } from "./audio.js";
import { AudioConfig } from "./config.js";
import { AudioError, logAudioError } from "./errors.js";
import { parseRange } from "./schema.js";

// statuses maps each audio error code to its HTTP status.
const statuses = { not_found: 404, unavailable: 503, internal: 500 } as const;

// audioResponse streams the whole file with a 200, only the asked bytes with a 206, or a bare 416 for a range past the end.
export const audioResponse = (path: string, range: string | undefined) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const size = Number((yield* fs.stat(path)).size);
    const asked = parseRange(range, size);
    if (asked._tag === "unsatisfiable") {
      return HttpServerResponse.empty({
        status: 416,
        headers: {
          "accept-ranges": "bytes",
          "content-range": `bytes */${size}`,
        },
      });
    }
    const start = asked._tag === "partial" ? asked.start : 0;
    const end = asked._tag === "partial" ? asked.end : size - 1;
    const length = end - start + 1;
    return HttpServerResponse.stream(
      fs.stream(path, { offset: start, bytesToRead: length }).pipe(
        Stream.mapError(() => new AudioError({ code: "internal" })),
        Stream.tapError(logAudioError),
      ),
      {
        status: asked._tag === "partial" ? 206 : 200,
        contentType: "audio/wav",
        contentLength: length,
        headers:
          asked._tag === "partial"
            ? {
                "accept-ranges": "bytes",
                "content-range": `bytes ${start}-${end}/${size}`,
              }
            : { "accept-ranges": "bytes" },
      },
    );
  }).pipe(
    Effect.mapError(
      (error) =>
        new AudioError({
          code:
            error._tag === "SystemError" && error.reason === "NotFound"
              ? "not_found"
              : "internal",
        }),
    ),
  );

// audioFor serves room's recording as wav honoring range, 404 when the call has no audio or the file is gone.
export const audioFor = (room: string, range: string | undefined) =>
  Effect.gen(function* () {
    const { directory: dir } = yield* AudioConfig;
    if (Option.isNone(dir)) {
      yield* Effect.logWarning("audio: AUDIO_DIR unset, refusing to serve");
      return yield* new AudioError({ code: "unavailable" });
    }
    const mongo = yield* MongoClient;
    const name = yield* findAudio(mongo, room);
    if (name === undefined) {
      return yield* new AudioError({ code: "not_found" });
    }
    return yield* audioResponse(audioPath(dir.value, name), range);
  }).pipe(
    Effect.catchAll((error) => {
      const code = error instanceof AudioError ? error.code : "internal";
      return (code === "internal" ? logAudioError(error) : Effect.void).pipe(
        Effect.zipRight(
          HttpServerResponse.json({ error: code }, { status: statuses[code] }),
        ),
      );
    }),
  );

// audioSnapshot serves GET /calls/:room/audio.
export const audioSnapshot = Effect.gen(function* () {
  const params = yield* HttpRouter.params;
  const request = yield* HttpServerRequest.HttpServerRequest;
  return yield* audioFor(params.room ?? "", request.headers["range"]);
});
