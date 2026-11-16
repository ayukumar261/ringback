import { Effect, Redacted } from "effect";
import { describe, expect, it, vi } from "vitest";
import { makeResendClient } from "./resend.js";

const email = { subject: "Call requested", html: "<p>Hello</p>" };

const harness = (key = "re_private", to = "owner@example.com") => {
  const fetch = vi.fn<typeof globalThis.fetch>(async () =>
    Response.json({ id: "email-test" }),
  );
  return {
    fetch,
    client: makeResendClient({ apiKey: Redacted.make(key), to, fetch }),
  };
};

describe("Resend email", () => {
  it("sends the email to the owner with the API key", async () => {
    const h = harness();
    await Effect.runPromise(h.client.send(email));
    const [url, init] = h.fetch.mock.calls[0]!;
    expect(url).toBe("https://api.resend.com/emails");
    expect(init).toMatchObject({
      method: "POST",
      headers: { Authorization: "Bearer re_private" },
      redirect: "error",
    });
    expect(JSON.parse(String(init!.body))).toEqual({
      from: "Corbyn AI <corbyn@ayukumar261.com>",
      to: "owner@example.com",
      ...email,
    });
  });

  it("reports HTTP failures by status, without the response body", async () => {
    const h = harness();
    h.fetch.mockResolvedValueOnce(
      new Response("private-provider-error", { status: 422 }),
    );
    const error = await Effect.runPromise(
      h.client.send(email).pipe(Effect.flip),
    );
    expect(error.code).toBe("http_422");
    expect(JSON.stringify(error)).not.toContain("private");
  });

  it("reports network failures as unavailable", async () => {
    const h = harness();
    h.fetch.mockRejectedValueOnce(new Error("private network error"));
    expect(
      (await Effect.runPromise(h.client.send(email).pipe(Effect.flip))).code,
    ).toBe("unavailable");
  });

  it.each([
    ["an API key", "", "owner@example.com"],
    ["a recipient", "re_private", ""],
  ])("refuses without %s", async (_, key, to) => {
    const h = harness(key, to);
    expect(
      (await Effect.runPromise(h.client.send(email).pipe(Effect.flip))).code,
    ).toBe("not_configured");
    expect(h.fetch).not.toHaveBeenCalled();
  });
});
