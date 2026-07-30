import { Schema } from "effect";
import type { MongoClient } from "../clients/mongo.js";
import { applyCallEnded, CallEnded } from "./call-ended.js";
import { applyCallStarted, CallStarted } from "./call-started.js";

export { CallEnded, CallStarted };

// CallEvent is every event the worker publishes today.
export const CallEvent = Schema.Union(CallStarted, CallEnded);
export type CallEvent = typeof CallEvent.Type;

// decodeCallEvent parses one stream entry's fields into a CallEvent.
export const decodeCallEvent = Schema.decodeUnknown(CallEvent);

// applyCallEvent routes one decoded event to its materializer, safe to repeat.
export const applyCallEvent = (mongo: MongoClient, ev: CallEvent) => {
  switch (ev.event) {
    case "call.started":
      return applyCallStarted(mongo, ev);
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
