import { describe, it, expect, vi, beforeEach } from "vitest";
import type { GrouponUnitRow } from "../data/groupon-units-db";

const row = (code: string, attempts = 0): GrouponUnitRow => ({
  redemptionCode: code,
  unitId: `unit-${code}`,
  grouponCode: `VS-${code}`,
  dealKey: "arcade25-laser4",
  items: [],
  valueAmount: 6500,
  currencyCode: "USD",
  fetchedAt: "2026-08-20T15:00:00Z",
  redeemState: "pending",
  redeemedAt: null,
  redeemAttempts: attempts,
  lastError: null,
});

const listPendingRedeems = vi.fn(async () => [] as GrouponUnitRow[]);
const countStalledRedeems = vi.fn(async () => 0);
const redeemAfterDelivery = vi.fn<(code: string) => Promise<{ redeemed: boolean }>>(async () => ({
  redeemed: true,
}));
let configured = true;

vi.mock("../data/groupon-units-db", () => ({
  listPendingRedeems: (...a: unknown[]) => listPendingRedeems(...(a as [])),
  countStalledRedeems: (...a: unknown[]) => countStalledRedeems(...(a as [])),
}));

vi.mock("../client.server", () => ({
  isGrouponConfigured: () => configured,
}));

vi.mock("./resolve.server", () => ({
  redeemAfterDelivery: (code: string) => redeemAfterDelivery(code),
}));

async function sweep(opts?: { dryRun?: boolean; limit?: number }) {
  const m = await import("./redeem-sweep.server");
  return m.runGrouponRedeemSweep(opts);
}

beforeEach(() => {
  vi.clearAllMocks();
  configured = true;
  listPendingRedeems.mockResolvedValue([]);
  countStalledRedeems.mockResolvedValue(0);
  redeemAfterDelivery.mockResolvedValue({ redeemed: true });
});

/**
 * This sweep is the ONLY thing that closes the window the safe ordering opens:
 * the guest gets their item before Groupon is told. A `pending` row is real
 * value handed over and unreported, so "quietly does nothing" is the one
 * outcome that must be impossible.
 */
describe("runGrouponRedeemSweep", () => {
  it("attempts nothing when Groupon is not configured", async () => {
    configured = false;

    const res = await sweep();

    expect(redeemAfterDelivery).not.toHaveBeenCalled();
    expect(listPendingRedeems).not.toHaveBeenCalled();
    expect(res.notes.join(" ")).toContain("not configured");
  });

  it("costs nothing on a quiet minute", async () => {
    const res = await sweep();

    expect(res).toMatchObject({ ok: true, examined: 0, redeemed: [], stillPending: [] });
    expect(redeemAfterDelivery).not.toHaveBeenCalled();
  });

  it("drives every pending row through the single writer", async () => {
    listPendingRedeems.mockResolvedValue([row("AAAA1111"), row("BBBB2222")]);

    const res = await sweep();

    expect(redeemAfterDelivery).toHaveBeenCalledTimes(2);
    expect(res.redeemed).toEqual(["AAAA1111", "BBBB2222"]);
    expect(res.stillPending).toEqual([]);
  });

  it("leaves a row that did not land pending for the next run", async () => {
    listPendingRedeems.mockResolvedValue([row("AAAA1111"), row("BBBB2222")]);
    redeemAfterDelivery.mockImplementation(async (code: string) => ({
      redeemed: code === "AAAA1111",
    }));

    const res = await sweep();

    expect(res.redeemed).toEqual(["AAAA1111"]);
    expect(res.stillPending).toEqual(["BBBB2222"]);
  });

  it("does not abandon the rest of the debt when one row throws", async () => {
    listPendingRedeems.mockResolvedValue([row("AAAA1111"), row("BBBB2222"), row("CCCC3333")]);
    redeemAfterDelivery.mockImplementation(async (code: string) => {
      if (code === "BBBB2222") throw new Error("neon timeout");
      return { redeemed: true };
    });

    const res = await sweep();

    expect(redeemAfterDelivery).toHaveBeenCalledTimes(3);
    expect(res.redeemed).toEqual(["AAAA1111", "CCCC3333"]);
    expect(res.stillPending).toEqual(["BBBB2222"]);
    expect(res.ok).toBe(false);
  });

  it("says out loud that stalled rows exist rather than going quiet", async () => {
    // Excluded from the worklist so they cannot starve it — but a human has to
    // know they are there, because it is money we owe Groupon.
    countStalledRedeems.mockResolvedValue(3);

    const res = await sweep();

    expect(res.stalled).toBe(3);
    expect(res.notes.join(" ")).toContain("needs a human");
  });

  it("sends nothing on a dry run", async () => {
    listPendingRedeems.mockResolvedValue([row("AAAA1111")]);

    const res = await sweep({ dryRun: true });

    expect(redeemAfterDelivery).not.toHaveBeenCalled();
    expect(res.stillPending).toEqual(["AAAA1111"]);
  });

  it("caps the worklist by attempts so a poisoned row cannot hog the LIMIT", async () => {
    await sweep({ limit: 5 });

    expect(listPendingRedeems).toHaveBeenCalledWith(5, 12);
  });
});
