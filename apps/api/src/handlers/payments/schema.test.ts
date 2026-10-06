import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { checkCallInput, requestSnapshotHash } from "./schema.js";

const input = {
  to: "+15551234567",
  prompt: "Ask for an economy flight price from SFO to LAX.",
};
const snapshot = {
  ...input,
  amount: 50,
  currency: "usd",
  maxDuration: 120,
  policyVersion: "prompt-rules-v1",
  requireTerms: false,
  environment: "production" as const,
};

describe("call input", () => {
  it("normalizes prompts and strips client-supplied pricing", async () => {
    expect(
      await Effect.runPromise(
        checkCallInput({ ...input, prompt: `  ${input.prompt}  `, amount: 1 }),
      ),
    ).toEqual(input);
  });
  it.each([
    null,
    [],
    {},
    { ...input, to: "555" },
    { ...input, to: "+01234567" },
    { ...input, prompt: "  " },
    { ...input, prompt: 4 },
    { ...input, prompt: "x".repeat(16001) },
  ])("rejects malformed input %j", async (body) => {
    await expect(Effect.runPromise(checkCallInput(body))).rejects.toThrow(
      "invalid_request",
    );
  });
  it.each([
    "Make a prank call",
    "Start a cold-call",
    "Impersonate the owner",
    "Send a bomb threat",
    "Try swatting",
  ])("rejects prohibited prompts: %s", async (prompt) => {
    await expect(
      Effect.runPromise(checkCallInput({ ...input, prompt })),
    ).rejects.toThrow("prompt_not_allowed");
  });
  it("accepts the maximum prompt length", async () => {
    expect(
      (
        await Effect.runPromise(
          checkCallInput({ ...input, prompt: "x".repeat(16000) }),
        )
      ).prompt,
    ).toHaveLength(16000);
  });
});

describe("request snapshot", () => {
  it.each([
    { to: "+15550000000" },
    { prompt: "New prompt" },
    { amount: 100 },
    { currency: "eur" },
    { maxDuration: 240 },
    { policyVersion: "v2" },
    { requireTerms: true },
    { environment: "development" as const },
  ])("binds each purchase term %j", (change) => {
    expect(requestSnapshotHash({ ...snapshot, ...change })).not.toBe(
      requestSnapshotHash(snapshot),
    );
  });
  it("ignores lifecycle changes", () => {
    const dialed = { ...snapshot, status: "dialed" };
    expect(requestSnapshotHash(dialed)).toBe(requestSnapshotHash(snapshot));
  });
});
