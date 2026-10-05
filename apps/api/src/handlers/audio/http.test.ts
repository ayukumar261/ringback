import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  Error as PlatformError,
  FileSystem,
  HttpApp,
  HttpRouter,
  HttpServerResponse,
} from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import { ConfigProvider, Effect } from "effect";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { MongoClient, type CallDoc } from "../../clients/mongo.js";
import { audioResponse, audioSnapshot } from "./http.js";
import { AudioConfig } from "./config.js";

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

  it("classifies a missing file as not_found", async () => {
    await expect(
      Effect.runPromise(
        audioResponse(join(dirname(path), "missing.wav"), undefined).pipe(
          Effect.provide(NodeFileSystem.layer),
        ),
      ),
    ).rejects.toThrow("not_found");
  });
});

describe("audio route", () => {
  let dir = "";
  const bytes = Buffer.from([0, 1, 2, 3, 4]);
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "ringback-audio-route-"));
    await writeFile(join(dir, "r-a.wav"), bytes);
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  const serve = (
    result: Partial<CallDoc> | null | Error,
    range?: string,
    enabled = true,
    filesystem = NodeFileSystem.layer,
  ) => {
    const findOne = vi.fn(async () => {
      if (result instanceof Error) throw result;
      return result;
    });
    const handler = HttpApp.toWebHandler(
      HttpRouter.empty.pipe(
        HttpRouter.get("/calls/:room/audio", audioSnapshot),
        Effect.provideService(MongoClient, {
          calls: { findOne },
        } as unknown as MongoClient),
        Effect.provide(filesystem),
        Effect.provide(AudioConfig.Default),
        Effect.withConfigProvider(
          ConfigProvider.fromMap(new Map(enabled ? [["AUDIO_DIR", dir]] : [])),
        ),
      ),
    );
    return {
      findOne,
      response: handler(
        new Request("http://localhost/calls/r-a/audio", {
          headers: range === undefined ? {} : { range },
        }),
      ),
    };
  };

  it("passes the route room and Range header through to playback", async () => {
    const { response: pending, findOne } = serve(
      { audio: "r-a.wav" },
      "bytes=1-3",
    );
    const response = await pending;
    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe("bytes 1-3/5");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(
      bytes.subarray(1, 4),
    );
    expect(findOne).toHaveBeenCalledWith(
      { room: "r-a" },
      { projection: { _id: 0, audio: 1 } },
    );
  });

  it("returns 503 before querying Mongo when audio is disabled", async () => {
    const { response: pending, findOne } = serve(null, undefined, false);
    const response = await pending;
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "unavailable" });
    expect(findOne).not.toHaveBeenCalled();
  });

  it.each([null, { audio: "" }, { room: "r-a" }, { audio: "missing.wav" }])(
    "returns 404 when no recording is available: %j",
    async (doc) => {
      const response = await serve(doc).response;
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "not_found" });
    },
  );

  it("sanitizes database failures", async () => {
    const response = await serve(new Error("mongodb://private-password"))
      .response;
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "internal" });
  });
  it("sanitizes filesystem permission errors without returning 404", async () => {
    const filesystem = FileSystem.layerNoop({
      stat: () =>
        Effect.fail(
          new PlatformError.SystemError({
            reason: "PermissionDenied",
            module: "FileSystem",
            method: "stat",
            pathOrDescriptor: "/private/audio/r-a.wav",
          }),
        ),
    });
    const response = await serve(
      { audio: "r-a.wav" },
      undefined,
      true,
      filesystem,
    ).response;
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "internal" });
  });
});
