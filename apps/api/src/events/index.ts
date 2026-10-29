import { Schema } from "effect";
import type { MongoClient } from "../clients/mongo.js";
import { applyCallEnded, CallEnded } from "./call-ended.js";
import { CallSip } from "./call-sip.js";
import { applyCallStarted, CallStarted } from "./call-started.js";
import { applyCallTurn, CallTurn } from "./call-turn.js";

export { CallEnded, CallSip, CallStarted, CallTurn };

// CallStream is the Redis stream key the worker publishes call events to.
export const CallStream = "ringback:calls";

// CallEvent is every event the customer's feed carries.
export const CallEvent = Schema.Union(CallStarted, CallTurn, CallEnded);
export type CallEvent = typeof CallEvent.Type;

// WorkerEvent is every event the worker publishes, including internal ones.
export const WorkerEvent = Schema.Union(CallEvent, CallSip);
export type WorkerEvent = typeof WorkerEvent.Type;

// decodeWorkerEvent parses one stream entry's fields into a WorkerEvent.
export const decodeWorkerEvent = Schema.decodeUnknown(WorkerEvent);

// applyCallEvent routes one decoded event to its materializer, safe to repeat.
export const applyCallEvent = (mongo: MongoClient, ev: CallEvent) => {
  switch (ev.event) {
    case "call.started":
      return applyCallStarted(mongo, ev);
    case "call.turn":
      return applyCallTurn(mongo, ev);
    case "call.ended":
      return applyCallEnded(mongo, ev);
  }
};

// entryFields turns a stream entry's flat [k1, v1, k2, v2] array into a record.
export const entryFields = (
  flat: ReadonlyArray<string>,
): Record<string, string> => {
  const rec: Record<string, string> = {};
  for (let i = 0; i + 1 < flat.length; i += 2) {
    const key = flat[i];
    const value = flat[i + 1];
    if (key !== undefined && value !== undefined) {
      rec[key] = value;
    }
  }
  return rec;
};
