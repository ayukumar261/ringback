import { Config, Effect } from "effect";
import { SipClient } from "livekit-server-sdk";

// LiveKitClient is the api's client for LiveKit's SIP service, which places outbound calls.
export class LiveKitClient extends Effect.Service<LiveKitClient>()("api/LiveKitClient", {
  effect: Effect.gen(function* () {
    const url = yield* Config.string("LIVEKIT_URL").pipe(
      Config.withDefault("http://127.0.0.1:7880"),
    );
    // empty defaults keep the api booting without LiveKit creds, so reads work and only dialing breaks
    const key = yield* Config.string("LIVEKIT_API_KEY").pipe(
      Config.withDefault(""),
    );
    const secret = yield* Config.string("LIVEKIT_API_SECRET").pipe(
      Config.withDefault(""),
    );
    return new SipClient(url, key, secret);
  }),
}) {}
