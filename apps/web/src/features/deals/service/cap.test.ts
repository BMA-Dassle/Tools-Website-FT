import { describe, it, expect } from "vitest";
import { capDecision } from "./cap";

const base = { maxPerBuyer: 10, dealName: "Laser Tag + Game Card" };

describe("capDecision", () => {
  it("allows a first purchase up to the limit", () => {
    expect(capDecision({ ...base, requested: 1, alreadyOwned: 0 })).toEqual({
      ok: true,
      alreadyOwned: 0,
      remaining: 10,
    });
    expect(capDecision({ ...base, requested: 10, alreadyOwned: 0 }).ok).toBe(true);
  });

  it("counts history, not just this order — the whole point of the cap", () => {
    // A per-order cap stops nothing; the buyer places a second order.
    const d = capDecision({ ...base, requested: 5, alreadyOwned: 6 });
    expect(d.ok).toBe(false);
    expect(d.remaining).toBe(4);
    expect(d.message).toContain("you can add 4 more");
  });

  it("allows exactly the remainder", () => {
    expect(capDecision({ ...base, requested: 4, alreadyOwned: 6 }).ok).toBe(true);
  });

  it("refuses once the buyer is at the limit, and points them at us", () => {
    const d = capDecision({ ...base, requested: 1, alreadyOwned: 10 });
    expect(d.ok).toBe(false);
    expect(d.remaining).toBe(0);
    expect(d.message).toContain("maximum of 10");
    expect(d.message).toContain("group");
  });

  it("never reports negative headroom if history somehow exceeds the cap", () => {
    // e.g. the limit was lowered after someone bought 12.
    const d = capDecision({ ...base, requested: 1, alreadyOwned: 12 });
    expect(d.remaining).toBe(0);
    expect(d.ok).toBe(false);
  });

  it("refuses a single order above the limit before looking at history", () => {
    const d = capDecision({ ...base, requested: 11, alreadyOwned: 0 });
    expect(d.ok).toBe(false);
    expect(d.message).toContain("limit of 10");
  });

  it("refuses a non-positive quantity", () => {
    expect(capDecision({ ...base, requested: 0, alreadyOwned: 0 }).ok).toBe(false);
    expect(capDecision({ ...base, requested: -3, alreadyOwned: 0 }).ok).toBe(false);
  });
});
