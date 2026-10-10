import { randomUUID } from "node:crypto";
import {
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "@effect/platform";
import { Effect, Stream } from "effect";
import type { Collection } from "mongodb";
import { LiveKitClient, LiveKitError } from "../../clients/livekit.js";
import {
  MongoClient,
  type PurchaseDoc,
  type RequestDoc,
} from "../../clients/mongo.js";
import {
  StripeClient,
  StripeError,
  type CheckoutSession,
} from "../../clients/stripe.js";
import { PaymentConfig } from "./config.js";
import { PaymentError, logPaymentError } from "./errors.js";
import {
  checkCallInput,
  hash,
  MAX_DURATION,
  POLICY_VERSION,
  requestSnapshotHash,
} from "./schema.js";
import {
  authorizeCallAccess,
  bearerToken,
  newAccessToken,
  newCallAccess,
  recoveredAccessToken,
  retryAccessToken,
  secretHash,
  validAccessSecret,
  type CreationCredentials,
} from "./access.js";

// statuses maps each payments error code to its HTTP status.
const statuses = {
  invalid_request: 400,
  unauthorized: 401,
  not_found: 404,
  conflict: 409,
  prompt_not_allowed: 422,
  internal: 500,
  unavailable: 503,
} as const;

// json responds with a body that browsers and proxies never cache.
export const json = (body: unknown, status = 200) =>
  HttpServerResponse.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });

// readBody reads the exact request bytes and stops as soon as they pass limit.
export const readBody = (limit: number) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const length = request.headers["content-length"];
    if (length && Number(length) > limit)
      return yield* new PaymentError({ code: "invalid_request" });
    const chunks: Uint8Array[] = [];
    yield* request.stream.pipe(
      Stream.runFoldEffect(0, (size, chunk) => {
        if (size + chunk.byteLength > limit)
          return Effect.fail(new PaymentError({ code: "invalid_request" }));
        chunks.push(chunk);
        return Effect.succeed(size + chunk.byteLength);
      }),
      Effect.catchTag("RequestError", () =>
        Effect.fail(new PaymentError({ code: "invalid_request" })),
      ),
    );
    return Buffer.concat(chunks);
  });

// paymentResponse answers a failed payments route with its error code.
export const paymentResponse = <E, R>(
  operation: string,
  effect: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
) =>
  effect.pipe(
    Effect.catchAll((error) => {
      const code =
        error instanceof PaymentError ||
        error instanceof StripeError ||
        error instanceof LiveKitError
          ? error.code
          : "internal";
      const status = statuses[code];
      return (
        status >= 500 ? logPaymentError(operation, error) : Effect.void
      ).pipe(Effect.zipRight(json({ error: code }, status)));
    }),
  );

// callResponse is the POST /call body for a request with a Checkout session.
const callResponse = (
  request: RequestDoc,
  settings: PaymentConfig,
  token: string,
) => {
  if (!request.checkout || !request.access)
    return Effect.fail(new PaymentError({ code: "unavailable" }));
  return Effect.succeed({
    call_id: request._id,
    status: request.status,
    checkout_url: request.checkout.url,
    status_url: `${settings.publicApiUrl}/call/${request._id}`,
    access_token: token,
    access_expires_at: request.access.expiresAt.toISOString(),
    dashboard_url: `${request.dashboardUrl ?? request.callUrl ?? `${settings.publicWebUrl}/call/${request._id}`}#token=${token}`,
    amount: request.amount,
    currency: request.currency,
    max_duration_seconds: request.maxDuration,
  });
};

// createCallRequest saves the call an agent asked for and returns its Checkout link.
export const createCallRequest = (
  input: unknown,
  idempotencyKey?: string,
  credentials: CreationCredentials = {},
) =>
  Effect.gen(function* () {
    const clean = yield* checkCallInput(input);
    if (
      idempotencyKey !== undefined &&
      (!idempotencyKey.trim() || idempotencyKey.length > 255)
    )
      return yield* new PaymentError({ code: "invalid_request" });
    if (
      credentials.recoverySecret !== undefined &&
      (!idempotencyKey || !validAccessSecret(credentials.recoverySecret))
    )
      return yield* new PaymentError({ code: "invalid_request" });
    const settings = yield* PaymentConfig;
    const environment = settings.environment;
    const mongo = yield* MongoClient;
    const stripe = yield* StripeClient;
    const dialer = yield* LiveKitClient;
    const keyHash = idempotencyKey
      ? hash(["call", environment, idempotencyKey])
      : undefined;
    const id = randomUUID();
    return yield* Effect.gen(function* () {
      const inputHash = hash(clean);
      // The legacy ID lookup prevents old keyed requests from creating a second checkout.
      const findExisting = () =>
        mongo.requests.findOne({
          environment,
          $or: [{ "retry.keyHash": keyHash }, { _id: keyHash }],
        });
      let record = keyHash ? yield* Effect.tryPromise(findExisting) : null;
      let token: string | undefined;
      if (record) {
        token = retryAccessToken(record, credentials);
      }
      if (!record) {
        // A read token is never a credential to create a new call.
        if (credentials.accessToken)
          return yield* new PaymentError({ code: "conflict" });
        yield* dialer.ready;
        const now = new Date();
        const recovery = credentials.recoverySecret
          ? {
              secretHash: secretHash(credentials.recoverySecret, "recovery"),
              salt: newAccessToken(),
            }
          : undefined;
        token = recovery
          ? recoveredAccessToken(credentials.recoverySecret!, recovery.salt)
          : newAccessToken();
        const snapshot = {
          ...clean,
          amount: settings.amount,
          currency: settings.currency,
          maxDuration: MAX_DURATION,
          policyVersion: POLICY_VERSION,
          requireTerms: settings.requireTerms,
          environment,
        };
        const fresh: RequestDoc = {
          _id: id,
          ...snapshot,
          inputHash,
          requestSnapshotHash: requestSnapshotHash(snapshot),
          createdAt: now,
          expiresAt: new Date(now.getTime() + 35 * 60_000),
          access: newCallAccess(token, now),
          ...(keyHash && { retry: { keyHash, ...(recovery && { recovery }) } }),
          status: "unpaid",
          room: `call_${id}`,
          dashboardUrl: `${settings.publicWebUrl}/call/${id}`,
        };
        yield* Effect.tryPromise({
          try: () => mongo.requests.insertOne(fresh),
          catch: (e) => e,
        }).pipe(
          Effect.catchAll((e) =>
            Effect.gen(function* () {
              if ((e as { code?: number })?.code !== 11000 || !keyHash)
                return yield* Effect.fail(e);
              // A concurrent request won. It must authorize this request's replay too.
              record = yield* Effect.tryPromise(findExisting);
              token = record
                ? retryAccessToken(record, credentials)
                : undefined;
            }),
          ),
        );
        if (!record) record = fresh;
      }
      if (
        !record ||
        !token ||
        record.inputHash !== inputHash ||
        record.environment !== environment
      )
        return yield* new PaymentError({ code: "conflict" });
      const requestId = record._id;
      const digest = record.requestSnapshotHash;
      if (!digest || requestSnapshotHash(record) !== digest)
        return yield* new PaymentError({ code: "conflict" });
      if (record.checkout) return yield* callResponse(record, settings, token);
      // Stripe needs at least 30 minutes left on a new Checkout session
      if (record.expiresAt.getTime() < Date.now() + 30 * 60_000)
        return yield* new PaymentError({ code: "conflict" });
      const { accountId, session } = yield* stripe.createSession({
        requestId: record._id,
        requestSnapshotHash: digest,
        amount: record.amount,
        currency: record.currency,
        maxDuration: record.maxDuration,
        expiresAt: record.expiresAt,
        returnUrl:
          record.dashboardUrl ??
          record.callUrl ??
          `${settings.publicWebUrl}/call/${record._id}`,
        requireTerms: record.requireTerms,
      });
      if (
        !accountId ||
        !session.url ||
        session.mode !== "payment" ||
        session.client_reference_id !== record._id ||
        session.amount_total !== record.amount ||
        session.currency !== record.currency ||
        session.metadata?.request_snapshot_hash !== digest ||
        session.livemode !== (environment === "production")
      )
        return yield* new PaymentError({ code: "conflict" });
      yield* Effect.tryPromise(() =>
        mongo.requests.updateOne(
          { _id: requestId, checkout: { $exists: false } },
          {
            $set: {
              checkout: {
                id: session.id,
                url: session.url!,
                accountId,
                livemode: session.livemode,
              },
            },
          },
        ),
      );
      const bound = yield* Effect.tryPromise(() =>
        mongo.requests.findOne({ _id: requestId }),
      );
      if (
        !bound?.checkout ||
        bound.inputHash !== inputHash ||
        bound.requestSnapshotHash !== digest ||
        requestSnapshotHash(bound) !== digest ||
        bound.checkout.id !== session.id ||
        bound.checkout.accountId !== accountId ||
        bound.checkout.livemode !== session.livemode
      )
        return yield* new PaymentError({ code: "conflict" });
      // Recheck revocation/expiry if access changed while Checkout was being created.
      if (!retryAccessToken(bound, { accessToken: token }))
        return yield* new PaymentError({ code: "conflict" });
      return yield* callResponse(bound, settings, token);
    }).pipe(
      Effect.tapError((error) => logPaymentError("checkout", error)),
      Effect.annotateLogs({ requestId: id }),
    );
  });

// createCall serves POST /call.
export const createCall = paymentResponse(
  "checkout",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const accessToken = yield* bearerToken(request.headers.authorization);
    const body = yield* readBody(100_000);
    const input = yield* Effect.try({
      try: () => JSON.parse(body.toString("utf8")) as unknown,
      catch: () => new PaymentError({ code: "invalid_request" }),
    });
    return yield* json(
      yield* createCallRequest(input, request.headers["idempotency-key"], {
        accessToken,
        recoverySecret: request.headers["idempotency-secret"],
      }),
      201,
    );
  }),
);

// recordPaidCheckout stores the purchase for a paid session the webhook already matched to its request.
export const recordPaidCheckout = (
  purchases: Collection<PurchaseDoc>,
  { accountId, session }: CheckoutSession,
) =>
  Effect.gen(function* () {
    if (
      session.mode !== "payment" ||
      session.status !== "complete" ||
      session.payment_status !== "paid"
    )
      return yield* new PaymentError({ code: "invalid_request" });
    const customerId =
      typeof session.customer === "string"
        ? session.customer
        : session.customer?.id;
    const intentId =
      typeof session.payment_intent === "string"
        ? session.payment_intent
        : session.payment_intent?.id;
    if (
      !accountId ||
      !session.id ||
      !session.client_reference_id ||
      !customerId ||
      !intentId ||
      !Number.isSafeInteger(session.amount_total) ||
      session.amount_total === null ||
      session.amount_total <= 0 ||
      !session.currency
    )
      return yield* new PaymentError({ code: "invalid_request" });
    const purchase: PurchaseDoc = {
      _id: `${accountId}:${session.livemode ? "live" : "test"}:${session.id}`,
      requestId: session.client_reference_id,
      stripeAccountId: accountId,
      livemode: session.livemode,
      checkoutSessionId: session.id,
      paymentIntentId: intentId,
      customer: {
        stripeId: customerId,
        name: session.customer_details?.name ?? null,
        email: session.customer_details?.email ?? null,
        phone: session.customer_details?.phone ?? null,
      },
      amountTotal: session.amount_total,
      currency: session.currency,
      recordedAt: new Date(),
    };
    const stored = yield* Effect.tryPromise({
      try: () =>
        purchases.findOneAndUpdate(
          { _id: purchase._id },
          { $setOnInsert: purchase },
          { upsert: true, returnDocument: "after" },
        ),
      catch: (e) => e,
    }).pipe(
      Effect.catchAll((e) =>
        (e as { code?: number })?.code === 11000
          ? Effect.tryPromise(() => purchases.findOne({ _id: purchase._id }))
          : Effect.fail(e),
      ),
    );
    if (!stored) return yield* new PaymentError({ code: "unavailable" });
    return stored;
  });

// readCallRequest reads a call's payment and dispatch status.
export const readCallRequest = (id: string, token: string | undefined) =>
  Effect.gen(function* () {
    const request = yield* authorizeCallAccess(id, token);
    return {
      call_id: id,
      status: request.status,
      room: request.dialedAt ? request.room : null,
      error: request.error ?? null,
    };
  });

// readCall serves GET /call/:id.
export const readCall = paymentResponse(
  "status",
  Effect.gen(function* () {
    const { id = "" } = yield* HttpRouter.params;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const token = yield* bearerToken(request.headers.authorization);
    if (!token) return yield* new PaymentError({ code: "unauthorized" });
    return yield* json(yield* readCallRequest(id, token));
  }),
);
