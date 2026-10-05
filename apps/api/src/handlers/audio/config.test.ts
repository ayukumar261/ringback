import { ConfigProvider, Effect, Option } from "effect";
import { describe, expect, it } from "vitest";
import { audioConfig, AudioConfig } from "./config.js";

const load = (directory?: string) =>
  Effect.runPromise(
    audioConfig.pipe(
      Effect.withConfigProvider(
        ConfigProvider.fromMap(
          new Map(directory === undefined ? [] : [["AUDIO_DIR", directory]]),
        ),
      ),
    ),
  );

describe("audio configuration", () => {
  it("disables audio when AUDIO_DIR is missing", async () => {
    expect((await load()).directory).toEqual(Option.none());
  });

  it.each(["/recordings", "./recordings", "/recordings with spaces"])(
    "preserves the configured path %s",
    async (path) => {
      expect((await load(path)).directory).toEqual(Option.some(path));
    },
  );

  it.each(["", " ", "\t\n", "/recordings\0private"])(
    "rejects an invalid configured path %j",
    async (path) => {
      await expect(load(path)).rejects.toThrow("AUDIO_DIR");
    },
  );

  it("provides the directory through the service", async () => {
    const settings = await Effect.runPromise(
      AudioConfig.pipe(
        Effect.provide(AudioConfig.Default),
        Effect.withConfigProvider(
          ConfigProvider.fromMap(new Map([["AUDIO_DIR", "/audio"]])),
        ),
      ),
    );
    expect(settings.directory).toEqual(Option.some("/audio"));
  });
});
