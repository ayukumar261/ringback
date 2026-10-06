import { ConfigProvider, Effect } from "effect";
import type {
  SIPOutboundTrunkInfo,
  SIPParticipantInfo,
} from "livekit-server-sdk";
import { describe, expect, it, vi } from "vitest";
import { LiveKitClient, makeLiveKitClient } from "./livekit.js";

const fixture = () => {
  const trunks = vi.fn(
    async () =>
      [
        { name: "another-trunk", sipTrunkId: "ST_other" },
        { name: "twilio-outbound", sipTrunkId: "ST_chosen" },
      ] as SIPOutboundTrunkInfo[],
  );
  const dial = vi.fn(async () => ({}) as SIPParticipantInfo);
  return {
    trunks,
    dial,
    client: makeLiveKitClient({
      listSipOutboundTrunk: trunks,
      createSipParticipant: dial,
    }),
  };
};
describe("LiveKit outbound adapter", () => {
  it("checks the deployed trunk without dialing", async () => {
    const f = fixture();
    await Effect.runPromise(f.client.ready);
    expect(f.dial).not.toHaveBeenCalled();
  });
  it("passes the configured duration limit, bounded timeouts, room, destination, and prompt", async () => {
    const f = fixture();
    await Effect.runPromise(
      f.client.dial({
        to: "+15551234567",
        room: "call_test",
        prompt: "Ask for a price",
        maxDuration: 120,
      }),
    );
    expect(f.dial).toHaveBeenCalledWith(
      "ST_chosen",
      "+15551234567",
      "call_test",
      {
        participantIdentity: "sip-outbound",
        maxCallDuration: 120,
        ringingTimeout: 30,
        timeout: 45,
        participantAttributes: {
          "ringback.direction": "outbound",
          "ringback.prompt": "Ask for a price",
        },
      },
    );
  });
  it("reports missing/unavailable trunks without dialing", async () => {
    const f = fixture();
    f.trunks.mockResolvedValueOnce([]);
    await expect(Effect.runPromise(f.client.ready)).rejects.toThrow(
      "unavailable",
    );
    f.trunks.mockRejectedValueOnce(new Error("private provider details"));
    await expect(
      Effect.runPromise(
        f.client.dial({
          to: "x",
          room: "r",
          prompt: "p",
          maxDuration: 1,
        }),
      ),
    ).rejects.toThrow("unavailable");
    expect(f.dial).not.toHaveBeenCalled();
  });
  it("sanitizes dial failures", async () => {
    const f = fixture();
    f.dial.mockRejectedValueOnce(new Error("private provider details"));
    const error = await Effect.runPromise(
      f.client
        .dial({ to: "x", room: "r", prompt: "p", maxDuration: 1 })
        .pipe(Effect.flip),
    );
    expect(error.code).toBe("unavailable");
    expect(JSON.stringify(error)).not.toContain("private");
  });
  it("boots without LiveKit credentials", async () => {
    const client = await Effect.runPromise(
      LiveKitClient.pipe(
        Effect.provide(LiveKitClient.Default),
        Effect.withConfigProvider(ConfigProvider.fromMap(new Map())),
      ),
    );
    expect(client.dial).toBeTypeOf("function");
  });
});
