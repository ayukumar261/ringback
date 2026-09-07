import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { MongoClient, type CallDoc } from "../clients/mongo.js";
import { audioPath, findAudio } from "./audio.js";

// fakeMongo yields the given call doc (or failure) and records each findOne call.
const fakeMongo = (result: Partial<CallDoc> | null | Error) => {
  const finds: unknown[] = [];
  const mongo = {
    calls: {
      findOne: (filter: unknown, options: unknown) => {
        finds.push({ filter, options });
        return result instanceof Error
          ? Promise.reject(result)
          : Promise.resolve(result);
      },
    },
  } as unknown as MongoClient;
  return { mongo, finds };
};

describe("findAudio", () => {
  it("returns the file name on an ended call with audio", async () => {
    const { mongo } = fakeMongo({ audio: "call_+15551234567_abc.wav" });
    expect(await Effect.runPromise(findAudio(mongo, "r-a"))).toBe(
      "call_+15551234567_abc.wav",
    );
  });

  it("asks Mongo for one room's audio field only", async () => {
    const { mongo, finds } = fakeMongo(null);
    await Effect.runPromise(findAudio(mongo, "r-a"));
    expect(finds).toEqual([
      { filter: { room: "r-a" }, options: { projection: { _id: 0, audio: 1 } } },
    ]);
  });

  it("returns undefined for an unknown room", async () => {
    const { mongo } = fakeMongo(null);
    expect(await Effect.runPromise(findAudio(mongo, "r-x"))).toBeUndefined();
  });

  it("returns undefined when recording was off", async () => {
    const { mongo } = fakeMongo({ audio: "" });
    expect(await Effect.runPromise(findAudio(mongo, "r-a"))).toBeUndefined();
  });

  it("returns undefined for a call that has not ended", async () => {
    const { mongo } = fakeMongo({ room: "r-a", status: "active" });
    expect(await Effect.runPromise(findAudio(mongo, "r-a"))).toBeUndefined();
  });

  it("fails when Mongo fails", async () => {
    const { mongo } = fakeMongo(new Error("down"));
    await expect(Effect.runPromise(findAudio(mongo, "r-a"))).rejects.toThrow();
  });
});

describe("audioPath", () => {
  it("joins the file name onto the audio dir", () => {
    expect(audioPath("/audio", "r-a.wav")).toBe("/audio/r-a.wav");
  });

  it("keeps only the basename so a doc cannot escape the dir", () => {
    expect(audioPath("/audio", "../../etc/passwd")).toBe("/audio/passwd");
    expect(audioPath("/audio", "/etc/passwd")).toBe("/audio/passwd");
  });
});
