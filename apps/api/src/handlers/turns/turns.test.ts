import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { MongoClient, type TurnDoc } from "../../clients/mongo.js";
import { listTurns } from "./turns.js";

// fakeMongo yields the given turn docs or failure and records each find call.
const fakeMongo = (result: TurnDoc[] | Error) => {
  const finds: unknown[] = [];
  const mongo = {
    turns: {
      find: (filter: unknown, options: unknown) => {
        finds.push({ filter, options });
        return {
          toArray: () =>
            result instanceof Error
              ? Promise.reject(result)
              : Promise.resolve(result),
        };
      },
    },
  } as unknown as MongoClient;
  return { mongo, finds };
};

describe("listTurns", () => {
  it("asks Mongo for one room's turns in order, without _id", async () => {
    const { mongo, finds } = fakeMongo([]);
    await Effect.runPromise(listTurns(mongo, "r-a"));
    expect(finds).toEqual([
      {
        filter: { room: "r-a" },
        options: { projection: { _id: 0 }, sort: { seq: 1 } },
      },
    ]);
  });

  it("returns an empty array for an unknown room", async () => {
    const { mongo } = fakeMongo([]);
    expect(await Effect.runPromise(listTurns(mongo, "r-x"))).toEqual([]);
  });
});

describe("data-access failures and encoding", () => {
  it("encodes database results before returning them", async () => {
    const { mongo } = fakeMongo([
      { room: "r-a", seq: 1, role: "agent", text: "Hello", at: new Date(123) },
    ]);
    expect(await Effect.runPromise(listTurns(mongo, "r-a"))).toEqual([
      { room: "r-a", seq: 1, role: "agent", text: "Hello", at: 123 },
    ]);
  });
  it("classifies a database failure without retaining credentials", async () => {
    const { mongo } = fakeMongo(new Error("mongodb://private-password"));
    const error = await Effect.runPromise(
      listTurns(mongo, "r-a").pipe(Effect.flip),
    );
    expect(error._tag).toBe("TurnsError");
    expect(error.code).toBe("internal");
    expect(JSON.stringify(error)).not.toContain("private-password");
  });
  it("classifies invalid stored data without retaining the document", async () => {
    const { mongo } = fakeMongo([
      {
        room: "r-a",
        seq: 1,
        role: "invalid" as never,
        text: "private",
        at: new Date(0),
      },
    ]);
    const error = await Effect.runPromise(
      listTurns(mongo, "r-a").pipe(Effect.flip),
    );
    expect(error.code).toBe("internal");
    expect(JSON.stringify(error)).not.toContain("private");
  });
});
