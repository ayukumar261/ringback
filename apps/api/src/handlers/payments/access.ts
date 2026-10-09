import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { Effect } from "effect";
import { MongoClient, type RequestDoc } from "../../clients/mongo.js";
import { PaymentError } from "./errors.js";

// Access outlives the 35-minute checkout window so completed results remain readable.
export const ACCESS_TOKEN_TTL_MS = 30 * 24 * 60 * 60_000;

export const newAccessToken = () => randomBytes(32).toString("base64url");

// Require a canonical encoding of exactly 32 bytes, including for recovery secrets.
export const validAccessSecret = (secret: string) =>
  /^[A-Za-z0-9_-]{43}$/.test(secret) &&
  Buffer.from(secret, "base64url").toString("base64url") === secret;

export const secretHash = (
  secret: string,
  kind: "access" | "recovery" = "access",
) =>
  createHash("sha256").update(`ringback:${kind}:`).update(secret).digest("hex");

const matchesSecret = (
  secret: string,
  digest: string,
  kind: "access" | "recovery",
) =>
  validAccessSecret(secret) &&
  /^[a-f0-9]{64}$/.test(digest) &&
  timingSafeEqual(
    Buffer.from(secretHash(secret, kind), "hex"),
    Buffer.from(digest, "hex"),
  );

// HMAC over a fresh 32-byte server salt lets a caller recover the same token.
// Neither the stored salt nor the secret hash suffices to recreate it.
export const recoveredAccessToken = (secret: string, salt: string) =>
  createHmac("sha256", Buffer.from(secret, "base64url"))
    .update("ringback:call-access:v1:")
    .update(Buffer.from(salt, "base64url"))
    .digest("base64url");

export const newCallAccess = (
  token: string,
  now: Date,
): NonNullable<RequestDoc["access"]> => ({
  tokenHash: secretHash(token),
  expiresAt: new Date(now.getTime() + ACCESS_TOKEN_TTL_MS),
});

export const hasCallAccess = (request: RequestDoc, token: string | undefined) =>
  !!(
    token &&
    request.access &&
    !request.access.revokedAt &&
    request.access.expiresAt.getTime() > Date.now() &&
    matchesSecret(token, request.access.tokenHash, "access")
  );

export interface CreationCredentials {
  accessToken?: string;
  recoverySecret?: string;
}

// No access is minted on replay. Only a known token or original recovery secret works.
export const retryAccessToken = (
  request: RequestDoc,
  credentials: CreationCredentials,
) => {
  let token = credentials.accessToken;
  if (credentials.recoverySecret) {
    const recovery = request.retry?.recovery;
    if (
      !recovery ||
      !matchesSecret(
        credentials.recoverySecret,
        recovery.secretHash,
        "recovery",
      )
    )
      return undefined;
    const recovered = recoveredAccessToken(
      credentials.recoverySecret,
      recovery.salt,
    );
    if (
      token &&
      (!request.access ||
        !matchesSecret(token, request.access.tokenHash, "access"))
    )
      return undefined;
    token = recovered;
  }
  return hasCallAccess(request, token) ? token : undefined;
};

// Unknown calls and invalid grants have the same response. IDs/rooms never authorize reads.
export const authorizeCallAccess = (id: string, token: string | undefined) =>
  Effect.gen(function* () {
    const mongo = yield* MongoClient;
    const request = yield* Effect.tryPromise(() =>
      mongo.requests.findOne({ _id: id }),
    );
    if (!request || !hasCallAccess(request, token))
      return yield* new PaymentError({ code: "not_found" });
    return request;
  });

export const bearerToken = (authorization: string | undefined) => {
  if (authorization === undefined) return Effect.succeed(undefined);
  const token = /^Bearer +([A-Za-z0-9_-]{43})$/i.exec(authorization)?.[1];
  return token && validAccessSecret(token)
    ? Effect.succeed(token)
    : Effect.fail(new PaymentError({ code: "unauthorized" }));
};
