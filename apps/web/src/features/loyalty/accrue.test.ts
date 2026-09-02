/**
 * accrueLoyaltyPoints: the call racing never made.
 *
 * The bug this guards against is an ABSENT request, so the assertions are
 * mostly about the wire: that an accumulate POST is actually issued, that it
 * carries the order id / program location / idempotency key, and that every
 * failure mode stays non-fatal so a loyalty problem can never fail a settle.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { accrueLoyaltyPoints } from "./accrue";

interface Call {
  method: string;
  path: string;
  body?: Record<string, unknown>;
}

let calls: Call[];
let responder: (c: Call) => { status: number; json: unknown };

beforeEach(() => {
  calls = [];
  process.env.SQUARE_ACCESS_TOKEN = "test-token";
  responder = (c) => {
    if (c.path.includes("/loyalty/accounts/search"))
      return { status: 200, json: { loyalty_accounts: [{ id: "acct-1" }] } };
    if (c.path.includes("/accumulate"))
      return { status: 200, json: { events: [{ accumulate_points: { points: 209 } }] } };
    return { status: 404, json: {} };
  };
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const call: Call = {
      method: init?.method ?? "GET",
      path: String(url),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    const { status, json } = responder(call);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => json,
      text: async () => JSON.stringify(json),
    } as Response;
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const INPUT = {
  orderId: "pkIVGRGCU8a3boN0BtiCcnG7m5IZY",
  locationId: "LAB52GY480CJF",
  customerId: "8CCJ3RGB3TVPJ7RYK492V7NQ2R",
  idempotencyKey: "race-dayof-loyalty-21759",
};

describe("accrueLoyaltyPoints", () => {
  it("issues the accumulate call and reports the points credited", async () => {
    const res = await accrueLoyaltyPoints(INPUT);

    expect(res).toEqual({ status: "accrued", points: 209, loyaltyAccountId: "acct-1" });

    const acc = calls.find((c) => c.path.includes("/accumulate"));
    expect(acc, "an accumulate POST must be issued — this is the whole bug").toBeDefined();
    expect(acc!.method).toBe("POST");
    expect(acc!.path).toContain("/loyalty/accounts/acct-1/accumulate");
    expect(acc!.body).toMatchObject({
      accumulate_points: { order_id: INPUT.orderId },
      location_id: "LAB52GY480CJF",
      idempotency_key: "race-dayof-loyalty-21759",
    });
  });

  it("sums points across multiple accrual events", async () => {
    responder = (c) =>
      c.path.includes("/loyalty/accounts/search")
        ? { status: 200, json: { loyalty_accounts: [{ id: "acct-1" }] } }
        : {
            status: 200,
            json: {
              events: [
                { accumulate_points: { points: 209 } },
                { accumulate_points: { points: 49 } },
              ],
            },
          };

    const res = await accrueLoyaltyPoints(INPUT);
    expect(res).toEqual({ status: "accrued", points: 258, loyaltyAccountId: "acct-1" });
  });

  it("skips silently when the guest has no loyalty account (card-on-file customer)", async () => {
    responder = () => ({ status: 200, json: { loyalty_accounts: [] } });

    const res = await accrueLoyaltyPoints(INPUT);
    expect(res).toEqual({ status: "no_account", customerId: INPUT.customerId });
    expect(calls.some((c) => c.path.includes("/accumulate"))).toBe(false);
  });

  it("does nothing at all without a customer — no wasted Square calls", async () => {
    const res = await accrueLoyaltyPoints({ ...INPUT, customerId: null });
    expect(res).toEqual({ status: "no_customer" });
    expect(calls).toHaveLength(0);
  });

  it("treats Square's balance-due rejection as a non-fatal skip", async () => {
    responder = (c) =>
      c.path.includes("/loyalty/accounts/search")
        ? { status: 200, json: { loyalty_accounts: [{ id: "acct-1" }] } }
        : {
            status: 400,
            json: {
              errors: [
                {
                  code: "BAD_REQUEST",
                  detail: "Order must be paid or completed to accumulate loyalty points",
                },
              ],
            },
          };

    const res = await accrueLoyaltyPoints(INPUT);
    expect(res).toEqual({
      status: "skipped",
      reason: "Order must be paid or completed to accumulate loyalty points",
    });
  });

  it("never throws when Square is unreachable", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("ECONNRESET");
    });

    const res = await accrueLoyaltyPoints(INPUT);
    expect(res).toEqual({ status: "error", reason: "ECONNRESET" });
  });

  it("reports an account-search failure without attempting to accrue", async () => {
    responder = () => ({ status: 500, json: { errors: [{ detail: "boom" }] } });

    const res = await accrueLoyaltyPoints(INPUT);
    expect(res).toEqual({ status: "error", reason: "account search 500" });
    expect(calls.some((c) => c.path.includes("/accumulate"))).toBe(false);
  });
});
