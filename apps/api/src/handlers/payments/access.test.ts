import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import { MongoClient, type RequestDoc } from "../../clients/mongo.js";
import {
  authorizeCallAccess,
  bearerToken,
  ACCESS_TOKEN_TTL_MS,
  hasCallAccess,
  newAccessToken,
  newCallAccess,
  recoveredAccessToken,
  retryAccessToken,
  secretHash,
  validAccessSecret,
} from "./access.js";

const token = newAccessToken();
const record = (changes: Partial<RequestDoc> = {}) =>
  ({
    _id: "one",
    access: newCallAccess(token, new Date()),
    ...changes,
  }) as RequestDoc;

describe("call access", () => {
  it("issues canonical 32-byte secrets and retains only a verifier", () => {
    const first = newAccessToken();
    const second = newAccessToken();
    expect(first).not.toBe(second);
    expect(Buffer.from(first, "base64url")).toHaveLength(32);
    const now = new Date();
    const grant = newCallAccess(first, now);
    expect(grant.expiresAt.getTime()).toBe(now.getTime() + ACCESS_TOKEN_TTL_MS);
    expect(JSON.stringify(grant)).not.toContain(first);
  });
  it.each([
    undefined,
    {
      ...newCallAccess(token, new Date()),
      expiresAt: new Date(Date.now() - 1),
    },
    { ...newCallAccess(token, new Date()), revokedAt: new Date() },
    { ...newCallAccess(token, new Date()), tokenHash: "malformed" },
  ])(
    "fails closed for absent, expired, revoked, or corrupt grants",
    (access) => {
      expect(hasCallAccess(record({ access }), token)).toBe(false);
    },
  );
  it("does not authorize an absent, wrong, or noncanonical secret", () => {
    for (const secret of [undefined, newAccessToken(), "x", token + "="]) {
      expect(hasCallAccess(record(), secret)).toBe(false);
    }
    expect(validAccessSecret("a".repeat(43))).toBe(false);
  });
  it("authorizes the requested call and rejects another call's token", async () => {
    const first = record();
    const other = record({
      _id: "two",
      access: newCallAccess(newAccessToken(), new Date()),
    });
    const findOne = vi.fn(async ({ _id }: { _id: string }) =>
      _id === "one" ? first : other,
    );
    const run = (id: string) =>
      Effect.runPromise(
        authorizeCallAccess(id, token).pipe(
          Effect.provideService(MongoClient, {
            requests: { findOne },
          } as unknown as MongoClient),
        ),
      );
    expect(await run("one")).toEqual(first);
    await expect(run("two")).rejects.toThrow("not_found");
  });
});

describe("creation recovery", () => {
  it("reconstructs only the original token with the original secret", () => {
    const secret = newAccessToken();
    const salt = newAccessToken();
    const recovered = recoveredAccessToken(secret, salt);
    const request = record({
      access: newCallAccess(recovered, new Date()),
      retry: {
        keyHash: "fixture-key",
        recovery: { secretHash: secretHash(secret, "recovery"), salt },
      },
    });
    expect(retryAccessToken(request, { recoverySecret: secret })).toBe(
      recovered,
    );
    expect(retryAccessToken(request, { accessToken: recovered })).toBe(
      recovered,
    );
    expect(retryAccessToken(request, {})).toBeUndefined();
    expect(
      retryAccessToken(request, { recoverySecret: newAccessToken() }),
    ).toBeUndefined();
    expect(
      retryAccessToken(request, { recoverySecret: secret, accessToken: token }),
    ).toBeUndefined();
    expect(JSON.stringify(request)).not.toContain(secret);
    expect(JSON.stringify(request)).not.toContain(recovered);
    expect(secretHash(secret, "recovery")).not.toBe(secretHash(secret));
  });
  it("cannot recover a revoked or expired token", () => {
    const secret = newAccessToken();
    const salt = newAccessToken();
    for (const changes of [
      { revokedAt: new Date() },
      { expiresAt: new Date(0) },
    ]) {
      expect(
        retryAccessToken(
          record({
            access: {
              ...newCallAccess(recoveredAccessToken(secret, salt), new Date()),
              ...changes,
            },
            retry: {
              keyHash: "fixture-key",
              recovery: { secretHash: secretHash(secret, "recovery"), salt },
            },
          }),
          { recoverySecret: secret },
        ),
      ).toBeUndefined();
    }
  });
});

describe("bearer headers", () => {
  it("accepts only a complete canonical bearer token", async () => {
    expect(await Effect.runPromise(bearerToken(`Bearer ${token}`))).toBe(token);
    expect(await Effect.runPromise(bearerToken(`bearer ${token}`))).toBe(token);
    expect(await Effect.runPromise(bearerToken(undefined))).toBeUndefined();
    for (const header of [
      "",
      "Basic password",
      `Bearer ${token} extra`,
      `Bearer ${token}=`,
      "Bearer short",
    ]) {
      await expect(Effect.runPromise(bearerToken(header))).rejects.toThrow(
        "unauthorized",
      );
    }
  });
});
