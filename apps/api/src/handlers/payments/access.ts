import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { Effect } from "effect";
import { MongoClient, type RequestDoc } from "../../clients/mongo.js";
import { PaymentError } from "./errors.js";

// Access outlives the 60-minute checkout window so completed results remain readable.
export const ACCESS_TOKEN_TTL_MS = 30 * 24 * 60 * 60_000;
export const HANDOFF_GRACE_MS = 5 * 60_000;

export const newAccessToken = () => randomBytes(32).toString("base64url");

export const callDashboardUrl = (
  request: Pick<RequestDoc, "dashboardUrl">,
  token: string,
) => `${request.dashboardUrl}#token=${token}`;

// Require a canonical encoding of exactly 32 bytes, including for recovery secrets.
export const validAccessSecret = (secret: string) =>
  /^[A-Za-z0-9_-]{43}$/.test(secret) &&
  Buffer.from(secret, "base64url").toString("base64url") === secret;

export const secretHash = (
  secret: string,
  kind: "access" | "recovery" | "handoff" = "access",
) =>
  createHash("sha256").update(`ringback:${kind}:`).update(secret).digest("hex");

const matchesSecret = (
  secret: string,
  digest: string,
  kind: "access" | "recovery" | "handoff",
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
): RequestDoc["access"] => ({
  tokenHash: secretHash(token),
  expiresAt: new Date(now.getTime() + ACCESS_TOKEN_TTL_MS),
});

export const hasCallAccess = (request: RequestDoc, token: string | undefined) =>
  !!(
    token &&
    !request.access.revokedAt &&
    request.access.expiresAt.getTime() > Date.now() &&
    (matchesSecret(token, request.access.tokenHash, "access") ||
      (request.access.browserTokenHash &&
        matchesSecret(token, request.access.browserTokenHash, "access")))
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
    if (token && !matchesSecret(token, request.access.tokenHash, "access"))
      return undefined;
    token = recovered;
  }
  return token &&
    hasCallAccess(request, token) &&
    matchesSecret(token, request.access.tokenHash, "access")
    ? token
    : undefined;
};

export const checkoutHandoffCode = (token: string, salt: string) =>
  createHmac("sha256", Buffer.from(token, "base64url"))
    .update("ringback:checkout-handoff:v1:")
    .update(Buffer.from(salt, "base64url"))
    .digest("base64url");

export const newCheckoutHandoff = (
  token: string,
  checkoutExpiresAt: Date,
): NonNullable<RequestDoc["handoff"]> => {
  const salt = newAccessToken();
  return {
    salt,
    codeHash: secretHash(checkoutHandoffCode(token, salt), "handoff"),
    expiresAt: new Date(checkoutExpiresAt.getTime() + HANDOFF_GRACE_MS),
  };
};

export const checkoutReturnUrl = (request: RequestDoc, token: string) =>
  request.handoff
    ? `${request.dashboardUrl}#handoff=${checkoutHandoffCode(token, request.handoff.salt)}`
    : request.dashboardUrl;

export const redeemCheckoutHandoff = (id: string, code: string) =>
  Effect.gen(function* () {
    if (!validAccessSecret(code))
      return yield* new PaymentError({ code: "not_found" });
    const mongo = yield* MongoClient;
    const now = new Date();
    const token = newAccessToken();
    const record = yield* Effect.tryPromise(() =>
      mongo.requests.findOneAndUpdate(
        {
          _id: id,
          "handoff.codeHash": secretHash(code, "handoff"),
          "handoff.expiresAt": { $gt: now },
          "handoff.redeemedAt": { $exists: false },
          "access.expiresAt": { $gt: now },
          "access.revokedAt": { $exists: false },
        },
        {
          $set: {
            "handoff.redeemedAt": now,
            "access.browserTokenHash": secretHash(token),
          },
        },
        { returnDocument: "after" },
      ),
    );
    if (!record) return yield* new PaymentError({ code: "not_found" });
    return { record, token };
  });

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
