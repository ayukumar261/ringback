import { basename, join } from "node:path";
import { Effect } from "effect";
import type { MongoClient } from "../../clients/mongo.js";
import { AudioError } from "./errors.js";

// findAudio reads the recording's file name off the call doc, undefined when the call has none.
export const findAudio = (mongo: MongoClient, room: string) =>
  Effect.tryPromise({
    try: () =>
      mongo.calls.findOne({ room }, { projection: { _id: 0, audio: 1 } }),
    catch: () => new AudioError({ code: "internal" }),
  }).pipe(
    Effect.map((doc) =>
      doc?.audio === undefined || doc.audio === "" ? undefined : doc.audio,
    ),
  );

// audioPath places the file under dir, keeping only the basename so the doc can never point outside it.
export const audioPath = (dir: string, name: string): string =>
  join(dir, basename(name));
