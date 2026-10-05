import { Config, Effect } from "effect";

// audioConfig reads the directory the worker writes recordings into, and leaving it unset disables the route.
export const audioConfig = Config.all({
  directory: Config.string("AUDIO_DIR").pipe(
    Config.validate({
      message: "AUDIO_DIR must be a nonblank path without null bytes",
      validation: (path) => path.trim().length > 0 && !path.includes("\0"),
    }),
    Config.option,
  ),
});

// AudioConfig is the validated audio settings.
export class AudioConfig extends Effect.Service<AudioConfig>()(
  "api/AudioConfig",
  { effect: audioConfig },
) {}
