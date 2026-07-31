import { Config, Effect } from "effect";
import { MongoClient as MongoDriver } from "mongodb";

// CallDoc is one call, active until its call.ended lands.
export interface CallDoc {
  room: string;
  status: "active" | "ended";
  conversationId?: string;
  from?: string;
  to?: string;
  startedAt?: Date;
  endedAt?: Date;
  durationMs?: number;
}

// TurnDoc is one transcript turn, unique per (room, seq).
export interface TurnDoc {
  room: string;
  seq: number;
  role: "caller" | "agent";
  text: string;
  at: Date;
}

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
      yield* Effect.tryPromise(() =>
        Promise.all([
          calls.createIndex({ room: 1 }, { unique: true }),
          calls.createIndex({ status: 1, startedAt: -1 }),
          turns.createIndex({ room: 1, seq: 1 }, { unique: true }),
        ]),
      );
      return { calls, turns, meta } as const;
    }),
  },
) {}
