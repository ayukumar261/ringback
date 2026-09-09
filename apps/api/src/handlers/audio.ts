import { basename, join } from "node:path";
import {
  FileSystem,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "@effect/platform";
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

// ByteRange is the inclusive span a Range header asks for, the whole file when the header is missing or unreadable, or unsatisfiable when it starts past the end.
export type ByteRange =
  | { readonly _tag: "full" }
  | { readonly _tag: "partial"; readonly start: number; readonly end: number }
  | { readonly _tag: "unsatisfiable" };

// parseRange reads one bytes range against a file of size bytes, clamping the end to the last byte and taking a suffix range as the last n bytes.
export const parseRange = (
  header: string | undefined,
  size: number,
): ByteRange => {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header?.trim() ?? "");
  const first = match?.[1] ?? "";
  const last = match?.[2] ?? "";
  if (match === null || (first === "" && last === "")) return { _tag: "full" };
  if (first !== "" && last !== "" && Number(first) > Number(last)) {
    return { _tag: "full" };
  }
  const start = first === "" ? Math.max(size - Number(last), 0) : Number(first);
  const end =
    first === "" || last === "" ? size - 1 : Math.min(Number(last), size - 1);
  return start >= size
    ? { _tag: "unsatisfiable" }
    : { _tag: "partial", start, end };
};

// audioResponse streams the whole file with a 200, only the asked bytes with a 206, or a bare 416 for a range past the end.
export const audioResponse = (path: string, range: string | undefined) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const size = Number((yield* fs.stat(path)).size);
    const asked = parseRange(range, size);
    if (asked._tag === "unsatisfiable") {
      return HttpServerResponse.empty({
        status: 416,
        headers: { "accept-ranges": "bytes", "content-range": `bytes */${size}` },
      });
    }
    const start = asked._tag === "partial" ? asked.start : 0;
    const end = asked._tag === "partial" ? asked.end : size - 1;
    const length = end - start + 1;
    return HttpServerResponse.stream(
      fs.stream(path, { offset: start, bytesToRead: length }),
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
  });

// audioFor serves room's recording as wav honoring range, 404 when the call has no audio or the file is gone.
export const audioFor = (room: string, range: string | undefined) =>
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
    return yield* audioResponse(audioPath(dir.value, name), range).pipe(
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
  const request = yield* HttpServerRequest.HttpServerRequest;
  return yield* audioFor(params.room ?? "", request.headers["range"]);
});
