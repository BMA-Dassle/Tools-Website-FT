/**
 * fetchRewardTier / fetchLoyaltyBalance: the kiosk terminal rail prices a
 * reward from Square's tier definition, never from the browser's number, and
 * refuses anything it can't price flat. Every failure returns null (fail
 * closed at the caller) — nothing here throws.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchLoyaltyBalance, fetchRewardTier } from "./reward-tier";

interface Call {
  method: string;
  path: string;
}

let calls: Call[];
let responder: (c: Call) => { status: number; json: unknown };

const PROGRAM = {
  program: {
    id: "prog-1",
    reward_tiers: [
      {
        id: "tier-10",
        name: "$10 off",
        points: 1000,
        definition: {
          scope: "ORDER",
          discount_type: "FIXED_AMOUNT",
          fixed_discount_money: { amount: 1000, currency: "USD" },
        },
      },
      {
        id: "tier-pct",
        name: "10% off",
        points: 500,
        definition: {
          scope: "ORDER",
          discount_type: "FIXED_PERCENTAGE",
          percentage_discount: "10",
        },
      },
      {
        id: "tier-item",
        name: "Free shoes",
        points: 300,
        definition: {
          scope: "ITEM_VARIATION",
          discount_type: "FIXED_AMOUNT",
          fixed_discount_money: { amount: 500, currency: "USD" },
        },
      },
    ],
  },
};

beforeEach(() => {
  calls = [];
  process.env.SQUARE_ACCESS_TOKEN = "test-token";
  responder = (c) => {
    if (c.path.endsWith("/loyalty/programs/main")) return { status: 200, json: PROGRAM };
    if (c.path.endsWith("/loyalty/accounts/acct-1"))
      return { status: 200, json: { loyalty_account: { id: "acct-1", balance: 2500 } } };
    return { status: 404, json: { errors: [{ code: "NOT_FOUND" }] } };
  };
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const call: Call = { method: init?.method ?? "GET", path: String(url) };
    calls.push(call);
    const { status, json } = responder(call);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => json,
      text: async () => JSON.stringify(json),
    } as Response;
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("fetchRewardTier", () => {
  it("prices an ORDER-scope fixed-amount tier from Square's definition", async () => {
    const tier = await fetchRewardTier("tier-10");
    expect(tier).toEqual({
      id: "tier-10",
      name: "$10 off",
      points: 1000,
      fixedDiscountCents: 1000,
    });
    expect(calls[0]).toMatchObject({ method: "GET" });
    expect(calls[0].path).toContain("/loyalty/programs/main");
  });

  it("returns the tier with a null flat discount for a percentage tier", async () => {
    const tier = await fetchRewardTier("tier-pct");
    expect(tier?.points).toBe(500);
    expect(tier?.fixedDiscountCents).toBeNull();
  });

  it("returns a null flat discount for an item-scope tier even when it has a fixed amount", async () => {
    const tier = await fetchRewardTier("tier-item");
    expect(tier?.fixedDiscountCents).toBeNull();
  });

  it("returns null for a tier that is not on the program", async () => {
    expect(await fetchRewardTier("tier-nope")).toBeNull();
  });

  it("returns null for an empty id without calling Square", async () => {
    expect(await fetchRewardTier("")).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("returns null when the program read fails", async () => {
    responder = () => ({ status: 500, json: { errors: [{ code: "INTERNAL" }] } });
    expect(await fetchRewardTier("tier-10")).toBeNull();
  });

  it("returns null when fetch throws", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("network down");
    });
    expect(await fetchRewardTier("tier-10")).toBeNull();
  });
});

describe("fetchLoyaltyBalance", () => {
  it("reads the account's current balance", async () => {
    expect(await fetchLoyaltyBalance("acct-1")).toBe(2500);
    expect(calls[0].path).toContain("/loyalty/accounts/acct-1");
  });

  it("returns null for an unknown account", async () => {
    expect(await fetchLoyaltyBalance("acct-missing")).toBeNull();
  });

  it("returns null for an empty id without calling Square", async () => {
    expect(await fetchLoyaltyBalance("")).toBeNull();
    expect(calls).toHaveLength(0);
  });
});
