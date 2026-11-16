import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import type { PurchaseDoc, RequestDoc } from "../clients/mongo.js";
import { ResendClient, ResendError } from "../clients/resend.js";
import { callDialedEmail, callRequestedEmail, sendEmail } from "./calls.js";

const request = {
  _id: "request-test",
  to: "+15551234567",
  prompt: 'Ask for <b>hours</b> & "prices".\nThen hang up.',
  amount: 50,
  currency: "usd",
} as RequestDoc;

const purchase = (amountTotal: number, email: string | null) =>
  ({
    amountTotal,
    currency: "usd",
    customer: { email },
  }) as PurchaseDoc;

describe("call emails", () => {
  it("describes a requested call and escapes the prompt", () => {
    const email = callRequestedEmail(request);
    expect(email.subject).toBe("Call requested: +15551234567");
    expect(email.html).toMatch(/^<!doctype html>/);
    expect(email.html).toContain(">request-test</code>");
    expect(email.html).toContain("$0.50");
    expect(email.html).toContain(
      "Ask for &#60;b&#62;hours&#60;/b&#62; &#38; &#34;prices&#34;.\nThen hang up.</pre>",
    );
    expect(email.html).not.toContain("<b>");
  });

  it("notes a coupon on a dialed call", () => {
    const email = callDialedEmail(request, purchase(0, "payer@example.com"));
    expect(email.subject).toBe("Call dialed: +15551234567");
    expect(email.html).toContain("$0.00 with a coupon (full price $0.50)");
    expect(email.html).toContain("payer@example.com");
  });

  it("shows a full-price dialed call without a coupon", () => {
    const email = callDialedEmail(request, purchase(50, null));
    expect(email.html).toContain("</strong> $0.50</li>");
    expect(email.html).not.toContain("coupon");
    expect(email.html).toContain("No email");
  });

  it("returns without waiting for the email or failing with it", async () => {
    const send = vi.fn(() =>
      Effect.fail(new ResendError({ code: "unavailable" })),
    );
    await Effect.runPromise(
      sendEmail(callRequestedEmail(request)).pipe(
        Effect.provideService(ResendClient, ResendClient.make({ send })),
      ),
    );
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
  });
});
