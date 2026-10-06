import { Config, Data, Effect, Redacted } from "effect";
import { SipClient } from "livekit-server-sdk";

// LiveKitError is a failed LiveKit call, carrying the error code the api responds with.
export class LiveKitError extends Data.TaggedError("LiveKitError")<{
  code: "unavailable";
}> {
  override get message() {
    return this.code;
  }
}

// DialInput is one outbound call, the room it joins, and the prompt it runs on.
export interface DialInput {
  to: string;
  room: string;
  prompt: string;
  maxDuration: number;
}

// Sip is the slice of the LiveKit client that placing a call needs.
export type Sip = Pick<
  SipClient,
  "listSipOutboundTrunk" | "createSipParticipant"
>;

// OUTBOUND_TRUNK_NAME is the trunk deploy/sip/outbound-trunk.json converges.
const OUTBOUND_TRUNK_NAME = "twilio-outbound";

// makeLiveKitClient checks for the outbound trunk and dials through it.
export const makeLiveKitClient = (sip: Sip) => {
  const trunk = Effect.tryPromise({
    try: () => sip.listSipOutboundTrunk(),
    catch: () => new LiveKitError({ code: "unavailable" }),
  }).pipe(
    Effect.flatMap((trunks) => {
      const found = trunks.find((t) => t.name === OUTBOUND_TRUNK_NAME);
      return found
        ? Effect.succeed(found.sipTrunkId)
        : Effect.fail(new LiveKitError({ code: "unavailable" }));
    }),
  );
  return {
    ready: Effect.asVoid(trunk),
    dial: (input: DialInput) =>
      Effect.gen(function* () {
        const trunkId = yield* trunk;
        yield* Effect.tryPromise({
          try: () =>
            sip.createSipParticipant(trunkId, input.to, input.room, {
              participantIdentity: "sip-outbound",
              maxCallDuration: input.maxDuration,
              ringingTimeout: 30,
              timeout: 45,
              participantAttributes: {
                "ringback.direction": "outbound",
                "ringback.prompt": input.prompt,
              },
            }),
          catch: () => new LiveKitError({ code: "unavailable" }),
        });
      }),
  };
};

// LiveKitClient is the api's client for LiveKit's SIP service, which places outbound calls.
export class LiveKitClient extends Effect.Service<LiveKitClient>()(
  "api/LiveKitClient",
  {
    effect: Effect.gen(function* () {
      const url = yield* Config.string("LIVEKIT_URL").pipe(
        Config.withDefault("http://127.0.0.1:7880"),
      );
      // empty defaults keep the api booting without LiveKit creds, so reads work and only dialing breaks
      const key = yield* Config.string("LIVEKIT_API_KEY").pipe(
        Config.withDefault(""),
      );
      const secret = yield* Config.redacted("LIVEKIT_API_SECRET").pipe(
        Config.withDefault(Redacted.make("")),
      );
      return makeLiveKitClient(new SipClient(url, key, Redacted.value(secret)));
    }),
  },
) {}
