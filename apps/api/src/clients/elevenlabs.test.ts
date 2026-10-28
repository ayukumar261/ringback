import { ConfigProvider, Effect, Redacted } from "effect";
import { describe, expect, it, vi } from "vitest";
import { elevenLabsConfig, makeElevenLabsClient } from "./elevenlabs.js";

const harness = (key = "private-key") => {
  const fetch = vi.fn<typeof globalThis.fetch>(async () =>
    Response.json({
      conversation_id: "conv-test",
      status: "done",
      transcript: [{ role: "agent", message: "private transcript" }],
      metadata: { cost: 900, cost_fiat: 0.095 },
    }),
  );
  return {
    fetch,
    client: makeElevenLabsClient({ apiKey: Redacted.make(key), fetch }),
  };
};

describe("ElevenLabs conversation price", () => {
  it("reads a conversation's status and dollar total with the API key", async () => {
    const h = harness();
    expect(
      await Effect.runPromise(h.client.getConversation("conv-test")),
    ).toEqual({ status: "done", metadata: { cost_fiat: 0.095 } });
    const [url, init] = h.fetch.mock.calls[0]!;
    expect(String(url)).toBe(
      "https://api.elevenlabs.io/v1/convai/conversations/conv-test",
    );
    expect(init).toMatchObject({
      headers: { "xi-api-key": "private-key" },
      redirect: "error",
    });
  });

  it("reads a conversation ElevenLabs hasn't priced yet as a null total", async () => {
    const h = harness();
    h.fetch.mockResolvedValueOnce(Response.json({ status: "processing" }));
    expect(
      await Effect.runPromise(h.client.getConversation("conv-test")),
    ).toEqual({ status: "processing", metadata: { cost_fiat: null } });
  });

  it("reports HTTP failures by status, without the response body", async () => {
    const h = harness();
    h.fetch.mockResolvedValueOnce(
      new Response("private-provider-error", { status: 401 }),
    );
    const error = await Effect.runPromise(
      h.client.getConversation("conv-test").pipe(Effect.flip),
    );
    expect(error.code).toBe("http_401");
    expect(JSON.stringify(error)).not.toContain("private");
  });

  it.each([-1, "0.1"])("rejects a total of %j", async (cost) => {
    const h = harness();
    h.fetch.mockResolvedValueOnce(
      Response.json({ status: "done", metadata: { cost_fiat: cost } }),
    );
    expect(
      (
        await Effect.runPromise(
          h.client.getConversation("conv-test").pipe(Effect.flip),
        )
      ).code,
    ).toBe("invalid_response");
  });

  it("refuses without an API key", async () => {
    const h = harness("");
    expect(
      (
        await Effect.runPromise(
          h.client.getConversation("conv-test").pipe(Effect.flip),
        )
      ).code,
    ).toBe("not_configured");
    expect(h.fetch).not.toHaveBeenCalled();
  });
});

it("loads the API key redacted", async () => {
  const config = await Effect.runPromise(
    Effect.gen(function* () {
      return yield* elevenLabsConfig;
    }).pipe(
      Effect.withConfigProvider(
        ConfigProvider.fromMap(new Map([["ELEVENLABS_API_KEY", "secret"]])),
      ),
    ),
  );
  expect(Redacted.value(config.apiKey)).toBe("secret");
  expect(JSON.stringify(config)).not.toContain("secret");
});
