import { randomUUID } from "node:crypto";
import {
  HttpApp,
  HttpRouter,
  HttpServerError,
  HttpServerRequest,
} from "@effect/platform";
import { Effect, Logger, Stream } from "effect";
import { MongoClient as Driver, type Collection } from "mongodb";
import type Stripe from "stripe";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  LiveKitClient,
  LiveKitError,
  type DialInput,
} from "../../clients/livekit.js";
import {
  MongoClient,
  createPurchaseIndexes,
  createRequestIndexes,
  type PurchaseDoc,
  type RequestDoc,
} from "../../clients/mongo.js";
import {
  StripeClient,
  StripeError,
  type CheckoutInput,
} from "../../clients/stripe.js";
import { PaymentConfig } from "./config.js";
import { PaymentError } from "./errors.js";
import {
  createCall,
  createCallRequest,
  json,
  paymentResponse,
  readBody,
  readCall,
  recordPaidCheckout,
} from "./http.js";
import { hash, MAX_DURATION, requestSnapshotHash } from "./schema.js";
import {
  newAccessToken,
  newCallAccess,
  secretHash,
  ACCESS_TOKEN_TTL_MS,
} from "./access.js";

const accessToken = newAccessToken();
const creationCredentials = { recoverySecret: newAccessToken() };

const bodyHandler = HttpApp.toWebHandler(
  paymentResponse(
    "test",
    Effect.gen(function* () {
      const bytes = yield* readBody(8);
      return yield* json({ text: bytes.toString("utf8") });
    }),
  ),
);
describe("payment HTTP boundary", () => {
  it("counts bytes rather than characters", async () => {
    const response = await bodyHandler(
      new Request("http://localhost", { method: "POST", body: "😀😀😀" }),
    );
    expect(response.status).toBe(400);
  });
  it("stops an oversized chunked body without trusting Content-Length", async () => {
    const chunks = [Buffer.from("1234"), Buffer.from("56789")];
    let cancelled = false;
    const stream = new ReadableStream({
      pull(controller) {
        const chunk = chunks.shift();
        if (chunk) controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    });
    const response = await bodyHandler(
      new Request("http://localhost", {
        method: "POST",
        body: stream,
        duplex: "half",
        headers: { "Content-Length": "1" },
      } as RequestInit),
    );
    expect(response.status).toBe(400);
    expect(cancelled).toBe(true);
  });
  it("keeps the original body bytes", async () => {
    const body = " {\n} ";
    const response = await bodyHandler(
      new Request("http://localhost", { method: "POST", body }),
    );
    expect(await response.json()).toEqual({ text: body });
  });
  it("rejects declared oversized bodies before reading them", async () => {
    const response = await bodyHandler(
      new Request("http://localhost", {
        method: "POST",
        body: "small",
        headers: { "Content-Length": "99" },
      }),
    );
    expect(response.status).toBe(400);
  });
  it("sanitizes a body read failure", async () => {
    const request = HttpServerRequest.fromWeb(
      new Request("http://localhost", { method: "POST", body: "body" }),
    );
    const broken = Object.create(
      request,
    ) as HttpServerRequest.HttpServerRequest;
    Object.defineProperty(broken, "stream", {
      value: Stream.fail(
        new HttpServerError.RequestError({
          request,
          reason: "Decode",
          cause: new Error("private input"),
        }),
      ),
    });
    const result = await Effect.runPromise(
      readBody(8).pipe(
        Effect.provideService(HttpServerRequest.HttpServerRequest, broken),
        Effect.flip,
      ),
    );
    expect(result.code).toBe("invalid_request");
  });
  it.each([
    [new PaymentError({ code: "invalid_request" }), 400, "invalid_request"],
    [new PaymentError({ code: "unauthorized" }), 401, "unauthorized"],
    [new PaymentError({ code: "not_found" }), 404, "not_found"],
    [new PaymentError({ code: "conflict" }), 409, "conflict"],
    [
      new PaymentError({ code: "prompt_not_allowed" }),
      422,
      "prompt_not_allowed",
    ],
    [new StripeError({ code: "unavailable" }), 503, "unavailable"],
    [new LiveKitError({ code: "unavailable" }), 503, "unavailable"],
    [new Error("private credentials"), 500, "internal"],
  ] as const)(
    "maps failures to safe responses",
    async (error, status, code) => {
      const response = await HttpApp.toWebHandler(
        paymentResponse("test", Effect.fail(error)),
      )(new Request("http://localhost"));
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({ error: code });
      expect(response.headers.get("cache-control")).toBe("no-store");
    },
  );
});

describe("checkout", () => {
  const route = HttpRouter.empty.pipe(HttpRouter.post("/call", createCall));
  const request = (body: string, headers: Record<string, string> = {}) =>
    new Request("http://localhost/call", { method: "POST", body, headers });

  const input = {
    to: "+15551234567",
    prompt: "Ask for an economy flight price from SFO to LAX.",
  };
  const settings = {
    amount: 50,
    currency: "usd",
    publicApiUrl: "http://localhost:3001",
    publicWebUrl: "http://localhost:3000",
    environment: "production" as const,
    requireTerms: false,
  };
  type Settings = Omit<PaymentConfig, "_tag">;
  const mongoUri = process.env.MONGODB_URI;
  const requestFixture = (changes: Partial<RequestDoc> = {}): RequestDoc => {
    const record = {
      _id: "request-test",
      ...input,
      inputHash: hash(input),
      access: newCallAccess(accessToken, new Date()),
      ...settings,
      maxDuration: MAX_DURATION,
      policyVersion: "prompt-rules-v1",
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 35 * 60_000),
      status: "unpaid",
      room: "call_request-test",
      checkout: {
        id: "cs_test",
        url: "https://checkout.stripe.com/test",
        accountId: "acct_test",
        livemode: true,
      },
      ...changes,
    } satisfies Omit<RequestDoc, "requestSnapshotHash">;
    return {
      ...record,
      requestSnapshotHash:
        changes.requestSnapshotHash ?? requestSnapshotHash(record),
    };
  };
  const sessionFixture = (changes: Partial<Stripe.Checkout.Session> = {}) =>
    ({
      id: "cs_test",
      object: "checkout.session",
      mode: "payment",
      status: "complete",
      payment_status: "paid",
      livemode: true,
      client_reference_id: "request-test",
      amount_total: 50,
      currency: "usd",
      metadata: { request_snapshot_hash: requestFixture().requestSnapshotHash },
      url: "https://checkout.stripe.com/test",
      customer: "cus_test",
      payment_intent: "pi_test",
      customer_details: {
        name: "Test payer",
        email: "payer@example.com",
        phone: null,
      },
      ...changes,
    }) as Stripe.Checkout.Session;
  const fakeMongo = () => ({
    requests: {
      findOne: vi.fn<(...args: unknown[]) => Promise<RequestDoc | null>>(
        async () => null,
      ),
      insertOne: vi.fn(async () => ({})),
      updateOne: vi.fn(async () => ({})),
    },
  });
  const harness = (
    mongo:
      | Pick<MongoClient, "requests">
      | ReturnType<typeof fakeMongo> = fakeMongo(),
  ) => {
    const sessions = new Map<string, Stripe.Checkout.Session>();
    const createSession = vi.fn(async (request: CheckoutInput) => {
      const id = `cs_${request.requestId}`;
      if (!sessions.has(id))
        sessions.set(
          id,
          sessionFixture({
            id,
            status: "open",
            payment_status: "unpaid",
            client_reference_id: request.requestId,
            amount_total: request.amount,
            currency: request.currency,
            metadata: {
              request_snapshot_hash: request.requestSnapshotHash,
            },
            url: `https://checkout.stripe.com/test/${id}`,
          }),
        );
      return { accountId: "acct_test", session: sessions.get(id)! };
    });

    const stripe = StripeClient.make({
      createSession: (request) =>
        Effect.tryPromise({
          try: () => createSession(request),
          catch: () => new StripeError({ code: "unavailable" }),
        }),
      retrieveSession: () =>
        Effect.dieMessage("Checkout must not retrieve a payment"),
      verifyEvent: () =>
        Effect.dieMessage("Checkout must not verify a webhook"),
    });
    const ready = vi.fn(async () => {});
    const dial = vi.fn<(request: DialInput) => Promise<void>>(async () => {});
    const dialer = LiveKitClient.make({
      ready: Effect.tryPromise({
        try: () => ready(),
        catch: () => new LiveKitError({ code: "unavailable" }),
      }),
      dial: (request) => Effect.promise(() => dial(request)),
    });
    const provide = <A, E, R>(
      effect: Effect.Effect<A, E, R>,
      overrides: Partial<Settings> = {},
    ) =>
      effect.pipe(
        Effect.provideService(MongoClient, mongo as MongoClient),
        Effect.provideService(StripeClient, stripe),
        Effect.provideService(LiveKitClient, dialer),
        Effect.provideService(
          PaymentConfig,
          PaymentConfig.make({ ...settings, ...overrides }),
        ),
      );
    return {
      sessions,
      createSession,
      ready,
      dial,
      run: <A, E>(
        effect: Effect.Effect<
          A,
          E,
          MongoClient | StripeClient | LiveKitClient | PaymentConfig
        >,
        overrides: Partial<Settings> = {},
      ) => Effect.runPromise(provide(effect, overrides)),
      http: (app: typeof route, overrides: Partial<Settings> = {}) =>
        HttpApp.toWebHandler(provide(app, overrides)),
    };
  };

  describe("checkout HTTP", () => {
    it("rejects malformed JSON and input before provider/database work", async () => {
      const mongo = fakeMongo();
      const h = harness(mongo);
      for (const [body, error] of [
        ["{", "invalid_request"],
        ["null", "invalid_request"],
        ['{"to":"555"}', "invalid_request"],
      ]) {
        const response = await h.http(route)(request(body!));
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({ error });
        expect(response.headers.get("cache-control")).toBe("no-store");
      }
      expect(mongo.requests.findOne).not.toHaveBeenCalled();
      expect(h.createSession).not.toHaveBeenCalled();
    });
    it("rejects oversized bodies while reading", async () => {
      expect(
        (await harness().http(route)(request("x".repeat(100001)))).status,
      ).toBe(400);
    });
    it.each(["", " ", "x".repeat(256)])(
      "rejects an invalid idempotency key",
      async (key) => {
        await expect(
          harness().run(createCallRequest(input, key)),
        ).rejects.toThrow("invalid_request");
      },
    );
    it("reports unavailable LiveKit without creating Checkout", async () => {
      const h = harness();
      h.ready.mockRejectedValueOnce(new Error("provider private response"));
      const result = await h.http(route)(request(JSON.stringify(input)));
      expect(result.status).toBe(503);
      expect(await result.json()).toEqual({ error: "unavailable" });
      expect(h.createSession).not.toHaveBeenCalled();
    });
    it.each([
      { "Idempotency-Secret": newAccessToken() },
      { "Idempotency-Key": "retry", "Idempotency-Secret": "short" },
      { "Idempotency-Key": "retry", "Idempotency-Secret": "a".repeat(43) },
    ] as Record<string, string>[])(
      "rejects invalid recovery credentials before database/provider work",
      async (headers) => {
        const mongo = fakeMongo();
        const h = harness(mongo);
        const response = await h.http(route)(
          request(JSON.stringify(input), headers),
        );
        expect(response.status).toBe(400);
        expect(mongo.requests.findOne).not.toHaveBeenCalled();
        expect(h.createSession).not.toHaveBeenCalled();
      },
    );
    it("passes Idempotency-Key and returns the original Checkout on retry", async () => {
      const mongo = fakeMongo();
      const record = requestFixture();
      mongo.requests.findOne.mockResolvedValue(record);
      const h = harness(mongo);
      const response = await h.http(route)(
        request(JSON.stringify(input), {
          "Idempotency-Key": "retry",
          Authorization: `Bearer ${accessToken}`,
        }),
      );
      expect(response.status).toBe(201);
      expect(await response.json()).toMatchObject({
        call_id: record._id,
        checkout_url: record.checkout!.url,
        status_url: `http://localhost:3001/call/${record._id}`,
        dashboard_url: `http://localhost:3000/call/${record._id}#token=${accessToken}`,
        access_token: accessToken,
        amount: 50,
      });
      expect(mongo.requests.findOne.mock.calls[0]![0]).toMatchObject({
        environment: "production",
        $or: [
          { "retry.keyHash": expect.stringMatching(/^[a-f0-9]{64}$/) },
          { _id: expect.stringMatching(/^[a-f0-9]{64}$/) },
        ],
      });
      expect(h.createSession).not.toHaveBeenCalled();
    });
  });

  describe.skipIf(!mongoUri)("checkout persistence", () => {
    const driver = new Driver(mongoUri ?? "mongodb://127.0.0.1:27017", {
      serverSelectionTimeoutMS: 3000,
    });
    const db = driver.db(`ringback_test_${randomUUID().replaceAll("-", "")}`);
    const mongo = {
      requests: db.collection<RequestDoc>("requests"),
      purchases: db.collection<PurchaseDoc>("purchases"),
    };
    beforeAll(async () => {
      await driver.connect();
      await Promise.all([
        createRequestIndexes(mongo.requests),
        createPurchaseIndexes(mongo.purchases),
      ]);
    });
    beforeEach(async () => {
      await Promise.all(
        Object.values(mongo).map((collection) => collection.deleteMany({})),
      );
      h.sessions.clear();
      vi.clearAllMocks();
    });
    afterAll(async () => {
      try {
        await db.dropDatabase();
      } finally {
        await driver.close();
      }
    });
    const h = { ...harness(mongo), mongo };
    it("returns a shareable website URL and uses it for Checkout returns", async () => {
      const response = await h.http(route, {
        publicApiUrl: "https://api.example.com/api",
        publicWebUrl: "https://example.com",
      })(
        request(
          JSON.stringify({
            ...input,
            dashboard_url: "https://untrusted.example",
            returnUrl: "https://untrusted.example",
          }),
        ),
      );
      expect(response.status).toBe(201);
      const result = await response.json();
      expect(result).toMatchObject({
        checkout_url: `https://checkout.stripe.com/test/cs_${result.call_id}`,
        status_url: `https://api.example.com/api/call/${result.call_id}`,
        dashboard_url: `https://example.com/call/${result.call_id}#token=${result.access_token}`,
      });
      expect(h.createSession.mock.calls[0]![0].returnUrl).toBe(
        `https://example.com/call/${result.call_id}`,
      );
      expect(
        (await h.mongo.requests.findOne({ _id: result.call_id }))?.dashboardUrl,
      ).toBe(`https://example.com/call/${result.call_id}`);
      expect(h.dial).not.toHaveBeenCalled();
      expect(await h.mongo.purchases.countDocuments()).toBe(0);
    });
    it("keeps one request and a fixed quote across concurrent retries/configuration changes", async () => {
      const results = await Promise.all(
        Array.from({ length: 8 }, () =>
          h.run(
            createCallRequest(
              { ...input, amount: 1, max_duration_seconds: 9999 },
              "same",
              creationCredentials,
            ),
          ),
        ),
      );
      expect(new Set(results.map((r) => r.call_id)).size).toBe(1);
      expect(await h.mongo.requests.countDocuments()).toBe(1);
      expect(h.sessions.size).toBe(1);
      expect(results[0]).toMatchObject({
        amount: 50,
        max_duration_seconds: MAX_DURATION,
      });
      expect(
        await h.run(createCallRequest(input, "same", creationCredentials), {
          amount: 100,
          publicWebUrl: "https://new.example",
        }),
      ).toEqual(results[0]);
      await expect(
        h.run(
          createCallRequest(
            { ...input, prompt: "Another call" },
            "same",
            creationCredentials,
          ),
        ),
      ).rejects.toThrow("conflict");
      expect(await h.mongo.purchases.countDocuments()).toBe(0);
      expect(h.dial).not.toHaveBeenCalled();
    });
    it("makes distinct requests when no idempotency key is supplied", async () => {
      const a = await h.run(createCallRequest(input));
      const b = await h.run(createCallRequest(input));
      expect(a.call_id).not.toBe(b.call_id);
    });
    it("recovers a Stripe failure using the original return URL and quote", async () => {
      h.createSession.mockRejectedValueOnce(new Error("network"));
      await expect(
        h.run(createCallRequest(input, "retry", creationCredentials)),
      ).rejects.toThrow("unavailable");
      const result = await h.run(
        createCallRequest(input, "retry", creationCredentials),
        {
          publicApiUrl: "https://new.example/api",
          publicWebUrl: "https://new.example",
          amount: 100,
        },
      );
      expect(result.status).toBe("unpaid");
      expect(h.createSession.mock.calls[1]![0]).toMatchObject({
        returnUrl: `http://localhost:3000/call/${result.call_id}`,
        amount: 50,
      });
      expect(result.dashboard_url).toBe(
        `http://localhost:3000/call/${result.call_id}#token=${result.access_token}`,
      );
      expect(await h.mongo.requests.countDocuments()).toBe(1);
    });
    it("recovers a crash between Stripe creation and the Mongo binding", async () => {
      const result = await h.run(
        createCallRequest(input, "test-request", creationCredentials),
      );
      await h.mongo.requests.updateOne(
        { _id: result.call_id },
        { $unset: { checkout: "" } },
      );
      expect(
        await h.run(
          createCallRequest(input, "test-request", creationCredentials),
        ),
      ).toEqual(result);
      expect(h.sessions.size).toBe(1);
    });
    it("rejects mismatched Stripe pricing without binding the session", async () => {
      h.createSession.mockImplementationOnce(async (r) => ({
        accountId: "acct_test",
        session: sessionFixture({
          id: "bad",
          client_reference_id: r.requestId,
          amount_total: 1,
        }),
      }));
      await expect(
        h.run(createCallRequest(input, "bad", creationCredentials)),
      ).rejects.toThrow("conflict");
      expect((await h.mongo.requests.findOne({}))?.checkout).toBeUndefined();
    });
    it("uses Sandbox checkout in development and scopes retries by environment", async () => {
      h.createSession.mockImplementationOnce(async (r) => ({
        accountId: "acct_sandbox",
        session: sessionFixture({
          id: "cs_sandbox",
          livemode: false,
          client_reference_id: r.requestId,
          metadata: { request_snapshot_hash: r.requestSnapshotHash },
        }),
      }));
      const development = await h.run(
        createCallRequest(input, "same", creationCredentials),
        {
          environment: "development",
        },
      );
      expect(h.ready).toHaveBeenCalledTimes(1);
      expect(h.dial).not.toHaveBeenCalled();
      expect(
        await h.mongo.requests.findOne({ _id: development.call_id }),
      ).toMatchObject({
        environment: "development",
        checkout: { livemode: false },
      });
      const production = await h.run(
        createCallRequest(input, "same", creationCredentials),
      );
      expect(production.call_id).not.toBe(development.call_id);
      expect(await h.mongo.requests.countDocuments()).toBe(2);
      expect(h.ready).toHaveBeenCalledTimes(2);
      expect(
        await h.run(createCallRequest(input, "same", creationCredentials), {
          environment: "development",
        }),
      ).toEqual(development);
      expect(h.createSession).toHaveBeenCalledTimes(2);
    });
    it.each(["development", "production"] as const)(
      "refuses a Checkout session from the wrong Stripe environment in %s",
      async (environment) => {
        h.createSession.mockImplementationOnce(async (r) => ({
          accountId: "acct_test",
          session: sessionFixture({
            client_reference_id: r.requestId,
            metadata: { request_snapshot_hash: r.requestSnapshotHash },
            livemode: environment !== "production",
          }),
        }));
        await expect(
          h.run(createCallRequest(input), { environment }),
        ).rejects.toThrow("conflict");
        expect((await h.mongo.requests.findOne({}))?.checkout).toBeUndefined();
      },
    );
    it("rejects stale incomplete checkouts without creating another session", async () => {
      h.createSession.mockRejectedValueOnce(new Error("network"));
      await expect(
        h.run(createCallRequest(input, "stale", creationCredentials)),
      ).rejects.toThrow();
      await h.mongo.requests.updateOne(
        {},
        { $set: { expiresAt: new Date(Date.now() + 29 * 60000) } },
      );
      await expect(
        h.run(createCallRequest(input, "stale", creationCredentials)),
      ).rejects.toThrow("conflict");
      expect(h.createSession).toHaveBeenCalledTimes(1);
    });
    it("keeps call IDs independent of caller keys and persists access without secrets", async () => {
      const result = await h.run(
        createCallRequest(input, "secret-key", creationCredentials),
      );
      expect(result.call_id).not.toBe(
        hash(["call", settings.environment, "secret-key"]),
      );
      expect(result.call_id).toMatch(/^[a-f0-9-]{36}$/);
      const stored = (await mongo.requests.findOne({ _id: result.call_id }))!;
      expect(stored).toMatchObject({
        access: {
          tokenHash: secretHash(result.access_token),
        },
      });
      expect(
        stored.access!.expiresAt.getTime() - stored.createdAt.getTime(),
      ).toBe(ACCESS_TOKEN_TTL_MS);
      for (const secret of [
        result.access_token,
        creationCredentials.recoverySecret,
        "secret-key",
      ]) {
        expect(JSON.stringify(stored)).not.toContain(secret);
        expect(JSON.stringify(h.createSession.mock.calls)).not.toContain(
          secret,
        );
      }
      expect(result.dashboard_url).toBe(
        `${stored.dashboardUrl}#token=${result.access_token}`,
      );
      expect(h.createSession.mock.calls[0]![0].returnUrl).toBe(
        stored.dashboardUrl,
      );
    });
    it("does not disclose or replace credentials on key/body-only retries", async () => {
      const result = await h.run(createCallRequest(input, "private"));
      const stored = await mongo.requests.findOne({ _id: result.call_id });
      for (const credentials of [
        {},
        { recoverySecret: newAccessToken() },
        { accessToken: newAccessToken() },
      ]) {
        await expect(
          h.run(createCallRequest(input, "private", credentials)),
        ).rejects.toThrow("conflict");
      }
      expect(await mongo.requests.findOne({ _id: result.call_id })).toEqual(
        stored,
      );
      expect(h.createSession).toHaveBeenCalledTimes(1);
      expect(
        await h.run(
          createCallRequest(input, "private", {
            accessToken: result.access_token,
          }),
        ),
      ).toEqual(result);
    });
    it("safely handles a lost response without recovery credentials", async () => {
      // Simulate a response discarded before the client learns either the ID or token.
      await h.run(createCallRequest(input, "lost"));
      const before = await mongo.requests.findOne({});
      await expect(h.run(createCallRequest(input, "lost"))).rejects.toThrow(
        "conflict",
      );
      expect(await mongo.requests.countDocuments()).toBe(1);
      expect(await mongo.requests.findOne({})).toEqual(before);
      expect(h.createSession).toHaveBeenCalledTimes(1);
    });
    it("recovers a lost HTTP response using the original recovery secret", async () => {
      const headers = {
        "Idempotency-Key": "lost",
        "Idempotency-Secret": creationCredentials.recoverySecret,
      };
      const first = await h.http(route)(
        request(JSON.stringify(input), headers),
      );
      const lostResponse = await first.json();
      const retry = await h.http(route)(
        request(JSON.stringify(input), headers),
      );
      expect(retry.status).toBe(201);
      expect(await retry.json()).toEqual(lostResponse);
      expect(await mongo.requests.countDocuments()).toBe(1);
      expect(h.createSession).toHaveBeenCalledTimes(1);
    });
    it("accepts an authenticated HTTP retry without the recovery secret", async () => {
      const first = await h.run(createCallRequest(input, "retry"));
      const response = await h.http(route)(
        request(JSON.stringify(input), {
          "Idempotency-Key": "retry",
          Authorization: `Bearer ${first.access_token}`,
        }),
      );
      expect(await response.json()).toEqual(first);
      expect(h.createSession).toHaveBeenCalledTimes(1);
    });
    it("does not let a call token authorize another call or create a new request", async () => {
      const first = await h.run(createCallRequest(input, "first"));
      await h.run(createCallRequest(input, "second"));
      for (const key of ["second", "new"]) {
        await expect(
          h.run(
            createCallRequest(input, key, { accessToken: first.access_token }),
          ),
        ).rejects.toThrow("conflict");
      }
      expect(await mongo.requests.countDocuments()).toBe(2);
      expect(h.createSession).toHaveBeenCalledTimes(2);
    });
    it("does not give concurrent clients with different secrets access to the winner", async () => {
      const outcomes = await Promise.allSettled(
        Array.from({ length: 8 }, () =>
          h.run(
            createCallRequest(input, "race", {
              recoverySecret: newAccessToken(),
            }),
          ),
        ),
      );
      expect(
        outcomes.filter((outcome) => outcome.status === "fulfilled"),
      ).toHaveLength(1);
      expect(
        outcomes.filter((outcome) => outcome.status === "rejected"),
      ).toHaveLength(7);
      expect(await mongo.requests.countDocuments()).toBe(1);
      expect(h.sessions.size).toBe(1);
    });
    it.each([{ revokedAt: new Date() }, { expiresAt: new Date(0) }])(
      "prevents bearer and recovery retries from restoring invalidated access %j",
      async (change) => {
        const result = await h.run(
          createCallRequest(input, "revoked", creationCredentials),
        );
        const access = (await mongo.requests.findOne({ _id: result.call_id }))!
          .access!;
        await mongo.requests.updateOne(
          { _id: result.call_id },
          { $set: { access: { ...access, ...change } } },
        );
        for (const credentials of [
          creationCredentials,
          { accessToken: result.access_token },
        ]) {
          await expect(
            h.run(createCallRequest(input, "revoked", credentials)),
          ).rejects.toThrow("conflict");
        }
        expect(h.createSession).toHaveBeenCalledTimes(1);
      },
    );
    it("rejects altered purchase terms on both replay and fresh Checkout binding", async () => {
      const result = await h.run(
        createCallRequest(input, "mutated", creationCredentials),
      );
      await mongo.requests.updateOne(
        { _id: result.call_id },
        { $set: { amount: 1 } },
      );
      await expect(
        h.run(createCallRequest(input, "mutated", creationCredentials)),
      ).rejects.toThrow("conflict");
      await mongo.requests.updateOne(
        { _id: result.call_id },
        { $unset: { checkout: "" } },
      );
      await expect(
        h.run(createCallRequest(input, "mutated", creationCredentials)),
      ).rejects.toThrow("conflict");
      expect(h.createSession).toHaveBeenCalledTimes(1);
    });
    it("refuses legacy key-based recovery rather than minting access or duplicating Checkout", async () => {
      const legacy = requestFixture({
        _id: hash(["call", settings.environment, "legacy"]),
        access: undefined,
      });
      delete legacy.access;
      await mongo.requests.insertOne(legacy);
      await expect(
        h.run(createCallRequest(input, "legacy", creationCredentials)),
      ).rejects.toThrow("conflict");
      expect(await mongo.requests.countDocuments()).toBe(1);
      expect(h.createSession).not.toHaveBeenCalled();
      expect(
        (await mongo.requests.findOne({ _id: legacy._id }))!.access,
      ).toBeUndefined();
    });
    it("rejects prohibited prompts before storing a request or contacting providers", async () => {
      await expect(
        h.run(createCallRequest({ ...input, prompt: "Make a prank call" })),
      ).rejects.toThrow("prompt_not_allowed");
      expect(await mongo.requests.countDocuments()).toBe(0);
      expect(h.ready).not.toHaveBeenCalled();
      expect(h.createSession).not.toHaveBeenCalled();
    });
    it("keeps request, recovery, and access secrets out of failure logs", async () => {
      const result = await h.run(
        createCallRequest(input, "sensitive-key", creationCredentials),
      );
      const entries: unknown[] = [];
      const logger = Logger.make((entry) => {
        entries.push(entry);
      });
      await expect(
        h.run(
          createCallRequest(input, "sensitive-key", {
            accessToken: newAccessToken(),
          }).pipe(Effect.provide(Logger.replace(Logger.defaultLogger, logger))),
        ),
      ).rejects.toThrow("conflict");
      expect(entries.length).toBeGreaterThan(0);
      const text = JSON.stringify(entries);
      for (const secret of [
        "sensitive-key",
        result.access_token,
        creationCredentials.recoverySecret,
      ])
        expect(text).not.toContain(secret);
    });
  });
});

describe("purchases", () => {
  const mongoUri = process.env.MONGODB_URI;
  const sessionFixture = (changes: Partial<Stripe.Checkout.Session> = {}) =>
    ({
      id: "cs_test",
      object: "checkout.session",
      mode: "payment",
      status: "complete",
      payment_status: "paid",
      livemode: false,
      client_reference_id: "request-test",
      amount_total: 50,
      currency: "usd",
      metadata: { request_snapshot_hash: "test-snapshot" },
      url: "https://checkout.stripe.com/test",
      customer: "cus_test",
      payment_intent: "pi_test",
      customer_details: {
        name: "Test payer",
        email: "payer@example.com",
        phone: null,
      },
      ...changes,
    }) as Stripe.Checkout.Session;
  const fakeMongo = () => ({ purchases: { findOneAndUpdate: vi.fn() } });

  describe("purchase validation", () => {
    it.each([
      { status: "open" },
      { status: "expired" },
      { payment_status: "unpaid" },
      { payment_status: "no_payment_required" },
      { mode: "subscription" },
    ] as const)("refuses unpaid sessions %j", async (change) => {
      const mongo = fakeMongo();
      await expect(
        Effect.runPromise(
          recordPaidCheckout(
            mongo.purchases as unknown as Collection<PurchaseDoc>,
            { accountId: "acct_test", session: sessionFixture(change) },
          ),
        ),
      ).rejects.toThrow("invalid_request");
      expect(mongo.purchases.findOneAndUpdate).not.toHaveBeenCalled();
    });
    it.each([
      "customer",
      "client_reference_id",
      "payment_intent",
      "amount_total",
      "currency",
    ] as const)("requires %s", async (field) => {
      const mongo = fakeMongo();
      const session = sessionFixture();
      Object.assign(session, { [field]: null });
      await expect(
        Effect.runPromise(
          recordPaidCheckout(
            mongo.purchases as unknown as Collection<PurchaseDoc>,
            { accountId: "acct_test", session },
          ),
        ),
      ).rejects.toThrow("invalid_request");
      expect(mongo.purchases.findOneAndUpdate).not.toHaveBeenCalled();
    });
    it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
      "rejects invalid amounts: %s",
      async (amount_total) => {
        await expect(
          Effect.runPromise(
            recordPaidCheckout(
              fakeMongo().purchases as unknown as Collection<PurchaseDoc>,
              {
                accountId: "acct_test",
                session: sessionFixture({ amount_total }),
              },
            ),
          ),
        ).rejects.toThrow("invalid_request");
      },
    );
  });

  describe.skipIf(!mongoUri)("purchase persistence", () => {
    const driver = new Driver(mongoUri ?? "mongodb://127.0.0.1:27017", {
      serverSelectionTimeoutMS: 3000,
    });
    const db = driver.db(`ringback_test_${randomUUID().replaceAll("-", "")}`);
    const mongo = { purchases: db.collection<PurchaseDoc>("purchases") };
    beforeAll(async () => {
      await driver.connect();
      await Promise.all([createPurchaseIndexes(mongo.purchases)]);
    });
    beforeEach(async () => {
      await Promise.all(
        Object.values(mongo).map((collection) => collection.deleteMany({})),
      );
    });
    afterAll(async () => {
      try {
        await db.dropDatabase();
      } finally {
        await driver.close();
      }
    });
    const record = (session = sessionFixture(), accountId = "acct_test") =>
      Effect.runPromise(
        recordPaidCheckout(mongo.purchases, { accountId, session }),
      );
    it("stores only the purchase snapshot, including customer contact details", async () => {
      const purchase = await record();
      expect(purchase).toEqual({
        _id: "acct_test:test:cs_test",
        requestId: "request-test",
        stripeAccountId: "acct_test",
        livemode: false,
        checkoutSessionId: "cs_test",
        paymentIntentId: "pi_test",
        customer: {
          stripeId: "cus_test",
          name: "Test payer",
          email: "payer@example.com",
          phone: null,
        },
        amountTotal: 50,
        currency: "usd",
        recordedAt: expect.any(Date),
      });
    });
    it("deduplicates concurrent writes and preserves the first snapshot", async () => {
      const results = await Promise.all(
        Array.from({ length: 20 }, () => record()),
      );
      expect(await mongo.purchases.countDocuments()).toBe(1);
      expect(new Set(results.map((r) => r._id)).size).toBe(1);
      const session = sessionFixture();
      session.customer_details!.name = "Updated name";
      expect(await record(session)).toEqual(results[0]);
    });
    it("accepts expanded objects and missing optional contacts", async () => {
      const purchase = await record(
        sessionFixture({
          customer: { id: "cus_test" } as Stripe.Customer,
          payment_intent: { id: "pi_test" } as Stripe.PaymentIntent,
          customer_details: null,
        }),
      );
      expect(purchase.customer).toEqual({
        stripeId: "cus_test",
        name: null,
        email: null,
        phone: null,
      });
    });
    it("keeps accounts, test/live modes, and sessions separate", async () => {
      await record();
      await record(sessionFixture(), "acct_other");
      await record(sessionFixture({ livemode: true }));
      await record(
        sessionFixture({ id: "cs_second", client_reference_id: "request-2" }),
      );
      expect(await mongo.purchases.countDocuments()).toBe(4);
    });
    it("supports customer history without merging matching email addresses", async () => {
      await record();
      await record(sessionFixture({ id: "cs_second" }));
      await record(sessionFixture({ id: "cs_other", customer: "cus_other" }));
      expect(
        await mongo.purchases.countDocuments({
          "customer.email": "payer@example.com",
        }),
      ).toBe(3);
      expect(
        await mongo.purchases.countDocuments({
          "customer.stripeId": "cus_test",
        }),
      ).toBe(2);
    });
  });
});

describe("status", () => {
  const route = HttpRouter.empty.pipe(HttpRouter.get("/call/:id", readCall));
  const requestFixture = (changes: Partial<RequestDoc> = {}) => ({
    _id: "request-test",
    room: "call_request-test",
    status: "unpaid" as const,
    to: "+15551234567",
    prompt: "Private call details",
    ...changes,
  });
  const fakeMongo = () => ({
    requests: {
      findOne: vi.fn<
        (
          ...args: unknown[]
        ) => Promise<ReturnType<typeof requestFixture> | null>
      >(async () => null),
    },
  });
  const handler = (mongo = fakeMongo()) =>
    HttpApp.toWebHandler(
      route.pipe(
        Effect.provideService(MongoClient, mongo as unknown as MongoClient),
      ),
    );

  describe("call status", () => {
    it("returns 404 for unknown requests", async () => {
      const response = await handler()(
        new Request("http://localhost/call/unknown"),
      );
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "not_found" });
    });
    it.each([false, true])(
      "exposes only public status fields (dialed: %s)",
      async (dialed) => {
        const mongo = fakeMongo();
        const record = requestFixture(
          dialed
            ? {
                status: "dialed",
                purchaseId: "acct_test:live:cs_test",
                dialedAt: new Date(),
              }
            : {},
        );
        mongo.requests.findOne.mockResolvedValue(record);
        const response = await handler(mongo)(
          new Request("http://localhost/call/request-test"),
        );
        expect(await response.json()).toEqual({
          call_id: record._id,
          status: record.status,
          room: dialed ? record.room : null,
          error: null,
        });
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(mongo.requests.findOne).toHaveBeenCalledWith({
          _id: record._id,
        });
      },
    );
    it("sanitizes database failures", async () => {
      const mongo = fakeMongo();
      mongo.requests.findOne.mockRejectedValueOnce(
        new Error("mongodb://private-password"),
      );
      const response = await handler(mongo)(
        new Request("http://localhost/call/x"),
      );
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: "internal" });
    });
  });
});
