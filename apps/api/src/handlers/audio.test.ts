import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { HttpServerResponse } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import { Effect } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MongoClient, type CallDoc } from "../clients/mongo.js";
import { audioPath, audioResponse, findAudio, parseRange } from "./audio.js";

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

describe("parseRange", () => {
  it("serves the whole file without a header or with one it cannot read", () => {
    const headers = [undefined, "", "bytes=", "bytes=-", "items=0-9", "bytes=9-3"];
    for (const header of headers) {
      expect(parseRange(header, 100)).toEqual({ _tag: "full" });
    }
  });

  it("reads a bounded range and clamps its end to the last byte", () => {
    expect(parseRange("bytes=10-19", 100)).toEqual({
      _tag: "partial",
      start: 10,
      end: 19,
    });
    expect(parseRange("bytes=90-500", 100)).toEqual({
      _tag: "partial",
      start: 90,
      end: 99,
    });
  });

  it("runs an open-ended range to the last byte", () => {
    expect(parseRange("bytes=40-", 100)).toEqual({
      _tag: "partial",
      start: 40,
      end: 99,
    });
  });

  it("takes a suffix range as the last n bytes", () => {
    expect(parseRange("bytes=-10", 100)).toEqual({
      _tag: "partial",
      start: 90,
      end: 99,
    });
    expect(parseRange("bytes=-500", 100)).toEqual({
      _tag: "partial",
      start: 0,
      end: 99,
    });
  });

  it("refuses a range that starts past the end", () => {
    expect(parseRange("bytes=100-", 100)).toEqual({ _tag: "unsatisfiable" });
    expect(parseRange("bytes=250-300", 100)).toEqual({ _tag: "unsatisfiable" });
    expect(parseRange("bytes=-0", 100)).toEqual({ _tag: "unsatisfiable" });
  });
});

describe("audioResponse", () => {
  // bytes is a 1000 byte file whose every byte is its own offset mod 256, so a slice proves which bytes were sent.
  const bytes = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 256));
  let path = "";

  beforeAll(async () => {
    const dir = await mkdtemp(join(tmpdir(), "ringback-audio-"));
    path = join(dir, "r-a.wav");
    await writeFile(path, bytes);
  });

  afterAll(() => rm(dirname(path), { recursive: true, force: true }));

  const serve = (range: string | undefined) =>
    Effect.runPromise(
      audioResponse(path, range).pipe(Effect.provide(NodeFileSystem.layer)),
    );
  const body = async (response: HttpServerResponse.HttpServerResponse) =>
    Buffer.from(await HttpServerResponse.toWeb(response).arrayBuffer());

  it("sends the whole file with a 200 and advertises ranges", async () => {
    const response = await serve(undefined);
    expect(response.status).toBe(200);
    expect(response.headers["accept-ranges"]).toBe("bytes");
    expect(response.headers["content-length"]).toBe("1000");
    expect(response.headers["content-type"]).toBe("audio/wav");
    expect(response.headers["content-range"]).toBeUndefined();
    expect(await body(response)).toEqual(bytes);
  });

  it("sends only the asked bytes with a 206", async () => {
    const response = await serve("bytes=100-199");
    expect(response.status).toBe(206);
    expect(response.headers["accept-ranges"]).toBe("bytes");
    expect(response.headers["content-range"]).toBe("bytes 100-199/1000");
    expect(response.headers["content-length"]).toBe("100");
    expect(await body(response)).toEqual(bytes.subarray(100, 200));
  });

  it("runs an open-ended range to the end of the file", async () => {
    const response = await serve("bytes=900-");
    expect(response.status).toBe(206);
    expect(response.headers["content-range"]).toBe("bytes 900-999/1000");
    expect(response.headers["content-length"]).toBe("100");
    expect(await body(response)).toEqual(bytes.subarray(900));
  });

  it("answers 416 with the file size for a range past the end", async () => {
    const response = await serve("bytes=1000-");
    expect(response.status).toBe(416);
    expect(response.headers["content-range"]).toBe("bytes */1000");
    expect(response.headers["accept-ranges"]).toBe("bytes");
    expect((await body(response)).length).toBe(0);
  });

  it("fails with NotFound when the file is gone", async () => {
    await expect(
      Effect.runPromise(
        audioResponse(join(dirname(path), "missing.wav"), undefined).pipe(
          Effect.provide(NodeFileSystem.layer),
        ),
      ),
    ).rejects.toThrow(/NotFound|ENOENT/);
  });
});
