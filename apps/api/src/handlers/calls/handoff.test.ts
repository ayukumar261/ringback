import { randomUUID } from "node:crypto";
import { HttpApp, HttpRouter } from "@effect/platform";
import { Effect } from "effect";
import { MongoClient as Driver } from "mongodb";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MongoClient, type RequestDoc } from "../../clients/mongo.js";
import {
  checkoutHandoffCode,
  hasCallAccess,
  newAccessToken,
  newCallAccess,
  newCheckoutHandoff,
  retryAccessToken,
} from "../payments/access.js";
import { PaymentConfig } from "../payments/config.js";
import { bootstrapCallAccess, callSnapshot } from "./http.js";

const origin = "https://ringback.test";
const uri = process.env.MONGODB_URI;

describe.skipIf(!uri)("Checkout browser handoff with MongoDB", () => {
  const driver = new Driver(uri ?? "mongodb://127.0.0.1:27017");
  const db = driver.db(`ringback_handoff_${randomUUID().replaceAll("-", "")}`);
  const requests = db.collection<RequestDoc>("requests");
  const handler = HttpApp.toWebHandler(
    HttpRouter.empty.pipe(
      HttpRouter.post("/call/:id/access", bootstrapCallAccess),
      HttpRouter.get("/call/:id", callSnapshot),
      Effect.provideService(MongoClient, {
        requests,
        calls: db.collection("calls"),
      } as unknown as MongoClient),
      Effect.provideService(
        PaymentConfig,
        PaymentConfig.make({
          publicWebUrl: origin,
          publicApiUrl: `${origin}/api`,
          environment: "production",
          amount: 50,
          currency: "usd",
        }),
      ),
    ),
  );
  beforeAll(() => driver.connect());
  beforeEach(() => requests.deleteMany({}));
  afterAll(async () => {
    await db.dropDatabase();
    await driver.close();
  });

  const create = async (id = "a") => {
    const token = newAccessToken();
    const expiresAt = new Date(Date.now() + 3600_000);
    const handoff = newCheckoutHandoff(token, expiresAt);
    const record: RequestDoc = {
      _id: id,
      inputHash: "input",
      requestSnapshotHash: "snapshot",
      to: "+15551234567",
      prompt: `Private task ${id}`,
      amount: 50,
      currency: "usd",
      maxDuration: 1800,
      terms: { version: "2026-10-30", url: `${origin}/terms` },
      privacy: { version: "2026-10-30", url: `${origin}/privacy` },
      environment: "production",
      createdAt: new Date(),
      expiresAt,
      access: newCallAccess(token, new Date()),
      handoff,
      dashboardUrl: `${origin}/call/${id}`,
      status: "unpaid",
      room: `room-${id}`,
      checkout: {
        id: `cs_${id}`,
        url: "https://checkout.stripe.com/test",
        accountId: "acct_test",
        livemode: true,
      },
    };
    await requests.insertOne(record);
    return { token, code: checkoutHandoffCode(token, handoff.salt), record };
  };
  const redeem = (
    code: string,
    id = "a",
    headers: Record<string, string> = {},
  ) =>
    handler(
      new Request(`${origin}/call/${id}/access`, {
        method: "POST",
        headers: { Origin: origin, "X-Checkout-Handoff": code, ...headers },
      }),
    );
  const cookie = (response: Response) =>
    response.headers.get("set-cookie")!.split(";")[0]!;
  const read = (id: string, headers: Record<string, string>) =>
    handler(new Request(`${origin}/call/${id}`, { headers }));

  it("grants the returning browser access while preserving the original private link", async () => {
    const { token, code, record } = await create();
    expect((await read("a", { Authorization: `Bearer ${code}` })).status).toBe(
      404,
    );
    const response = await redeem(code);
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toMatch(/HttpOnly/i);
    expect(response.headers.get("set-cookie")).toMatch(/Secure/i);
    expect(response.headers.get("set-cookie")).toContain("SameSite=Lax");
    expect(response.headers.get("set-cookie")).toContain("Path=/api/call/a");
    expect(await response.json()).toEqual({
      access_expires_at: record.access.expiresAt.toISOString(),
    });
    const browserToken = cookie(response).split("=")[1]!;
    expect(browserToken).not.toBe(token);
    expect(browserToken).not.toBe(code);
    const stored = (await requests.findOne({ _id: "a" }))!;
    for (const secret of [token, code, browserToken])
      expect(JSON.stringify(stored)).not.toContain(secret);
    expect(stored.handoff?.redeemedAt).toBeInstanceOf(Date);
    expect(hasCallAccess(stored, browserToken)).toBe(true);
    expect(
      retryAccessToken(stored, { accessToken: browserToken }),
    ).toBeUndefined();
    expect(retryAccessToken(stored, { accessToken: token })).toBe(token);
    expect((await read("a", { Cookie: cookie(response) })).status).toBe(200);
    const original = await read("a", { Authorization: `Bearer ${token}` });
    expect((await original.json()).dashboard_url).toBe(
      `${record.dashboardUrl}#token=${token}`,
    );
    expect((await read("a", { Authorization: `Bearer ${code}` })).status).toBe(
      404,
    );
    expect((await redeem(code)).status).toBe(404);
    await create("b");
    expect((await read("b", { Cookie: cookie(response) })).status).toBe(404);
  });

  it("redeems only once under concurrent requests", async () => {
    const { code } = await create();
    const responses = await Promise.all(
      Array.from({ length: 12 }, () => redeem(code)),
    );
    expect(responses.filter((r) => r.status === 200)).toHaveLength(1);
    expect(responses.filter((r) => r.status === 404)).toHaveLength(11);
    const winner = responses.find((r) => r.status === 200)!;
    expect((await read("a", { Cookie: cookie(winner) })).status).toBe(200);
  });

  it("consumes the handoff even when the browser already opened the private link", async () => {
    const { token, code } = await create();
    const response = await redeem(code, "a", {
      Cookie: `ringback_access=${token}`,
    });
    expect(response.status).toBe(200);
    expect((await requests.findOne({}))?.handoff?.redeemedAt).toBeInstanceOf(
      Date,
    );
    expect((await redeem(code)).status).toBe(404);
    expect((await read("a", { Authorization: `Bearer ${token}` })).status).toBe(
      200,
    );
  });

  it("retains the browser cookie from cancel through a later payment return", async () => {
    const { code } = await create();
    const cancel = await redeem(code);
    await requests.updateOne({ _id: "a" }, { $set: { status: "paid" } });
    const paid = await redeem(code, "a", { Cookie: cookie(cancel) });
    expect(paid.status).toBe(200);
    expect(cookie(paid)).toBe(cookie(cancel));
    expect(
      (await (await read("a", { Cookie: cookie(paid) })).json()).status,
    ).toBe("paid");
    expect((await redeem(code)).status).toBe(404);
  });

  it.each([
    "expired-code",
    "expired-access",
    "revoked",
    "wrong-call",
    "legacy",
    "malformed",
  ])("rejects %s without issuing browser access", async (scenario) => {
    const { code } = await create();
    if (scenario === "expired-code")
      await requests.updateOne(
        {},
        { $set: { "handoff.expiresAt": new Date(0) } },
      );
    if (scenario === "expired-access")
      await requests.updateOne(
        {},
        { $set: { "access.expiresAt": new Date(0) } },
      );
    if (scenario === "revoked")
      await requests.updateOne(
        {},
        { $set: { "access.revokedAt": new Date() } },
      );
    if (scenario === "legacy")
      await requests.updateOne({}, { $unset: { handoff: "" } });
    if (scenario === "wrong-call") await create("b");
    const response = await redeem(
      scenario === "malformed" ? "bad" : code,
      scenario === "wrong-call" ? "b" : "a",
    );
    expect(response.status).toBe(404);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(await response.json()).toEqual({ error: "not_found" });
    expect(
      await requests.countDocuments({
        "access.browserTokenHash": { $exists: true },
      }),
    ).toBe(0);
  });

  it("accepts a return during the short grace period after Checkout expires", async () => {
    const { code } = await create();
    await requests.updateOne(
      {},
      {
        $set: {
          expiresAt: new Date(Date.now() - 1000),
          "handoff.expiresAt": new Date(Date.now() + 60_000),
        },
      },
    );
    expect((await redeem(code)).status).toBe(200);
  });

  it.each(["https://other.test", "null", ""])(
    "enforces Origin before consuming the code: %s",
    async (Origin) => {
      const { code } = await create();
      expect((await redeem(code, "a", { Origin })).status).toBe(401);
      expect((await requests.findOne({}))?.handoff?.redeemedAt).toBeUndefined();
      expect((await redeem(code)).status).toBe(200);
    },
  );

  it("lets a valid handoff replace a stale cookie and honors explicit bearer credentials", async () => {
    const { code } = await create();
    expect(
      (await redeem(code, "a", { Authorization: "Bearer bad" })).status,
    ).toBe(401);
    expect(
      (
        await redeem(code, "a", {
          Cookie: `ringback_access=${newAccessToken()}`,
        })
      ).status,
    ).toBe(200);
  });

  it.each(["revoked", "expired"])(
    "invalidates the browser grant when access is %s",
    async (scenario) => {
      const { code } = await create();
      const response = await redeem(code);
      await requests.updateOne(
        {},
        {
          $set:
            scenario === "revoked"
              ? { "access.revokedAt": new Date() }
              : { "access.expiresAt": new Date(0) },
        },
      );
      expect((await read("a", { Cookie: cookie(response) })).status).toBe(404);
      expect(
        (await redeem(code, "a", { Cookie: cookie(response) })).status,
      ).toBe(404);
    },
  );
});
