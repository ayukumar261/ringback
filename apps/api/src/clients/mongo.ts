import { Config, Effect } from "effect";
import { MongoClient as MongoDriver, type Collection } from "mongodb";
import type { Environment } from "../environment.js";

// PurchaseDoc is one paid Checkout session with the customer's details at payment time.
export interface PurchaseDoc {
  _id: string;
  requestId: string;
  stripeAccountId: string;
  livemode: boolean;
  checkoutSessionId: string;
  paymentIntentId: string;
  customer: {
    stripeId: string;
    name: string | null;
    email: string | null;
    phone: string | null;
  };
  amountTotal: number;
  currency: string;
  recordedAt: Date;
}

// createPurchaseIndexes records each session once and finds purchases by request or customer.
export const createPurchaseIndexes = (purchases: Collection<PurchaseDoc>) =>
  Promise.all([
    purchases.createIndex(
      { stripeAccountId: 1, livemode: 1, checkoutSessionId: 1 },
      { unique: true },
    ),
    purchases.createIndex({ requestId: 1 }),
    purchases.createIndex({
      stripeAccountId: 1,
      livemode: 1,
      "customer.stripeId": 1,
      recordedAt: -1,
    }),
  ]);

// RequestDoc is one call an agent asked for, from checkout through dispatch.
export interface RequestDoc {
  _id: string;
  inputHash: string;
  requestSnapshotHash: string;
  to: string;
  prompt: string;
  amount: number;
  currency: string;
  maxDuration: number;
  policyVersion: string;
  requireTerms: boolean;
  environment: Environment;
  createdAt: Date;
  expiresAt: Date;
  access?: {
    tokenHash: string;
    expiresAt: Date;
    revokedAt?: Date;
  };
  retry?: {
    // Separate from the random call ID; retained even after checkout/access expiry.
    keyHash: string;
    // The salt is public; recreating a token also requires the caller's recovery secret.
    recovery?: { secretHash: string; salt: string };
  };
  dashboardUrl?: string;
  // Legacy records keep their original, secret-free Stripe return URL.
  callUrl?: string;
  status: "unpaid" | "paid" | "dialing" | "dialed" | "expired" | "failed";
  room: string;
  checkout?: { id: string; url: string; accountId: string; livemode: boolean };
  purchaseId?: string;
  paidAt?: Date;
  claimedAt?: Date;
  dialedAt?: Date;
  // error says why dialing failed, which can happen after the call already went through.
  error?: string;
}

// createRequestIndexes binds each Checkout session to one request and orders the dispatch queue.
export const createRequestIndexes = (requests: Collection<RequestDoc>) =>
  Promise.all([
    requests.createIndex(
      { environment: 1, "retry.keyHash": 1 },
      {
        unique: true,
        partialFilterExpression: { "retry.keyHash": { $type: "string" } },
      },
    ),
    requests.createIndex(
      { "checkout.accountId": 1, "checkout.livemode": 1, "checkout.id": 1 },
      {
        unique: true,
        partialFilterExpression: { "checkout.id": { $type: "string" } },
      },
    ),
    requests.createIndex({ status: 1, createdAt: 1 }),
  ]);

// CallDoc is one call, active until its call.ended lands.
export interface CallDoc {
  room: string;
  status: "active" | "ended";
  conversationId?: string;
  from?: string;
  to?: string;
  direction?: string;
  prompt?: string;
  startedAt?: Date;
  endedAt?: Date;
  durationMs?: number;
  audio?: string;
  audioStartedAt?: Date;
}

// createCallIndexes keeps one doc per room and sorts calls by start time.
export const createCallIndexes = (calls: Collection<CallDoc>) =>
  Promise.all([
    calls.createIndex({ room: 1 }, { unique: true }),
    calls.createIndex({ status: 1, startedAt: -1 }),
  ]);

// TurnDoc is one transcript turn, unique per (room, seq).
export interface TurnDoc {
  room: string;
  seq: number;
  role: "user" | "agent" | "tool";
  text: string;
  at: Date;
  startedAt?: Date;
  endedAt?: Date;
  durationMs?: number;
}

// createTurnIndexes keeps one turn per room and seq.
export const createTurnIndexes = (turns: Collection<TurnDoc>) =>
  turns.createIndex({ room: 1, seq: 1 }, { unique: true });

// MetaDoc keys small pieces of consumer state by name.
export interface MetaDoc {
  _id: string;
  lastAppliedId?: string;
}

// MongoClient owns the connection plus the collections the api reads and writes.
export class MongoClient extends Effect.Service<MongoClient>()(
  "api/MongoClient",
  {
    scoped: Effect.gen(function* () {
      const uri = yield* Config.string("MONGODB_URI").pipe(
        Config.withDefault("mongodb://127.0.0.1:27017/ringback"),
      );
      const client = yield* Effect.acquireRelease(
        Effect.tryPromise(() => MongoDriver.connect(uri)),
        (c) => Effect.tryPromise(() => c.close()).pipe(Effect.ignore),
      );
      const db = client.db();
      const calls = db.collection<CallDoc>("calls");
      const turns = db.collection<TurnDoc>("turns");
      const meta = db.collection<MetaDoc>("meta");
      const purchases = db.collection<PurchaseDoc>("purchases");
      const requests = db.collection<RequestDoc>("requests");
      yield* Effect.tryPromise(() =>
        Promise.all([
          createCallIndexes(calls),
          createTurnIndexes(turns),
          createPurchaseIndexes(purchases),
          createRequestIndexes(requests),
        ]),
      );
      return { calls, turns, meta, purchases, requests } as const;
    }),
  },
) {}
