/**
 * Void: kill the value, leave the money.
 *
 * The whole point of this suite is that a void is NOT a refund. If these two
 * ever collapse into one state, the first real refund becomes indistinguishable
 * from a void in every report built on this board, and the buyer-cap arithmetic
 * silently corrupts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getDealPurchase: vi.fn(),
  voidNativeVoucher: vi.fn(),
  markDealVouchersVoided: vi.fn(),
  recordSaleAction: vi.fn(),
  listSaleActions: vi.fn(),
  getDealMoneyState: vi.fn(),
  getDealMoneyStates: vi.fn(),
  getVoucherStatus: vi.fn(),
}));

vi.mock("~/features/deals/data/deal-purchases-db", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getDealPurchase: mocks.getDealPurchase,
}));
vi.mock("~/features/deals/data/deal-purchases-money", () => ({
  getDealMoneyState: mocks.getDealMoneyState,
  getDealMoneyStates: mocks.getDealMoneyStates,
  markDealVouchersVoided: mocks.markDealVouchersVoided,
}));
vi.mock("~/features/game-cards/service/native-voucher", () => ({
  getVoucherStatus: mocks.getVoucherStatus,
  voidNativeVoucher: mocks.voidNativeVoucher,
}));
vi.mock("~/features/game-cards/service/voucher-mail", () => ({
  emailPurchasedVouchers: vi.fn(),
  smsPurchasedVouchers: vi.fn(),
}));
vi.mock("~/features/deals/service/purchase", () => ({
  fulfilDealPurchase: vi.fn(),
  dealScheduleUrl: () => null,
}));
vi.mock("../data/web-sales-audit-db", () => ({
  recordSaleAction: mocks.recordSaleAction,
  listSaleActions: mocks.listSaleActions,
}));

const { dealsAdapter, projectDealRow, dealCapabilities } = await import("./deals");
const { makeDealPurchaseRow } = await import("../test-support");

const NO_MONEY = {
  vouchersVoidedAt: null,
  vouchersVoidedReason: null,
  refundedPacks: 0,
  refundedCents: 0,
  fullyRefundedAt: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.voidNativeVoucher.mockResolvedValue(undefined);
  mocks.markDealVouchersVoided.mockResolvedValue(undefined);
  mocks.recordSaleAction.mockResolvedValue(undefined);
  mocks.listSaleActions.mockResolvedValue([]);
  mocks.getDealMoneyState.mockResolvedValue(NO_MONEY);
  mocks.getDealMoneyStates.mockResolvedValue(new Map());
});

describe("void", () => {
  it("voids every code and records why", async () => {
    mocks.getDealPurchase.mockResolvedValue(makeDealPurchaseRow({ codes: ["A", "B"] }));
    const res = await dealsAdapter.void!({
      ref: "412",
      unitKeys: null,
      reason: "bought twice",
      actor: "admin",
    });
    expect(mocks.voidNativeVoucher).toHaveBeenCalledTimes(2);
    expect(mocks.voidNativeVoucher).toHaveBeenCalledWith("A", "admin void: bought twice");
    expect(mocks.markDealVouchersVoided).toHaveBeenCalledWith(412, "bought twice");
    expect(res.voided).toBe(2);
  });

  it("says plainly that no money moved", async () => {
    // The failure mode worth designing against is a staff member clicking Void
    // believing the guest gets their money back.
    mocks.getDealPurchase.mockResolvedValue(makeDealPurchaseRow());
    const res = await dealsAdapter.void!({
      ref: "412",
      unitKeys: null,
      reason: "fraud",
      actor: "admin",
    });
    expect(res.note).toMatch(/no money moved/i);
  });

  it("keeps going when one code fails, and names the survivors", async () => {
    // A hard abort mid-loop leaves some codes live with no record of why —
    // strictly worse than voiding what we can and reporting the rest.
    mocks.getDealPurchase.mockResolvedValue(makeDealPurchaseRow({ codes: ["A", "B", "C"] }));
    mocks.voidNativeVoucher.mockImplementation(async (code: string) => {
      if (code === "B") throw new Error("neon timeout");
    });
    const res = await dealsAdapter.void!({
      ref: "412",
      unitKeys: null,
      reason: "fraud",
      actor: "admin",
    });
    expect(res.voided).toBe(2);
    expect(res.note).toContain("B");
    // The intent is still recorded even though the sweep was incomplete.
    expect(mocks.markDealVouchersVoided).toHaveBeenCalled();
  });

  it("writes an audit row carrying the reason and the failures", async () => {
    mocks.getDealPurchase.mockResolvedValue(makeDealPurchaseRow({ codes: ["A"] }));
    await dealsAdapter.void!({ ref: "412", unitKeys: null, reason: "wrong recipient", actor: "admin" });
    expect(mocks.recordSaleAction).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "deals",
        ref: "412",
        action: "void",
        detail: { reason: "wrong recipient", voided: 1, failed: [] },
      }),
    );
  });

  it("404s for a purchase that does not exist", async () => {
    mocks.getDealPurchase.mockResolvedValue(null);
    await expect(
      dealsAdapter.void!({ ref: "999", unitKeys: null, reason: "x y z", actor: "admin" }),
    ).rejects.toThrow("not_found");
  });
});

describe("projection reads the new void column", () => {
  it("shows a fresh void even though it never touches refunded_at", async () => {
    // New voids write `vouchers_voided_at` ONLY. Reading just the legacy column
    // would render a voided sale as an ordinary live one.
    const row = makeDealPurchaseRow({ refundedAt: null });
    const projected = projectDealRow(row, {
      ...NO_MONEY,
      vouchersVoidedAt: "2026-08-03T20:00:00.000Z",
      vouchersVoidedReason: "fraud",
    });
    expect(projected.refund).toEqual({
      kind: "voided",
      at: "2026-08-03T20:00:00.000Z",
      reason: "fraud",
    });
  });

  it("still honours the legacy column for rows written before the migration", async () => {
    const row = makeDealPurchaseRow({ refundedAt: "2026-07-01T00:00:00.000Z", refundReason: "old" });
    expect(projectDealRow(row, NO_MONEY).refund).toEqual({
      kind: "voided",
      at: "2026-07-01T00:00:00.000Z",
      reason: "old",
    });
  });

  it("reports refunded money as a REFUND, not a void", async () => {
    const row = makeDealPurchaseRow({ refundedAt: null });
    expect(
      projectDealRow(row, {
        ...NO_MONEY,
        refundedCents: 3621,
        refundedPacks: 1,
        fullyRefundedAt: "2026-08-03T21:00:00.000Z",
      }).refund,
    ).toMatchObject({ kind: "full", refundedCents: 3621 });
  });

  it("calls a part-refunded purchase partial", async () => {
    expect(
      projectDealRow(makeDealPurchaseRow({ qty: 3, refundedAt: null }), {
        ...NO_MONEY,
        refundedCents: 1207,
        refundedPacks: 1,
      }).refund,
    ).toMatchObject({ kind: "partial", refundedCents: 1207 });
  });

  it("prefers the refund over the void when a purchase has both", async () => {
    // Refunding and then voiding the leftovers is legitimate; the money is the
    // more consequential fact.
    expect(
      projectDealRow(makeDealPurchaseRow(), {
        ...NO_MONEY,
        refundedCents: 3621,
        fullyRefundedAt: "2026-08-03T21:00:00.000Z",
        vouchersVoidedAt: "2026-08-03T21:05:00.000Z",
      }).refund.kind,
    ).toBe("full");
  });

  it("blocks refund and void once the new column says voided", async () => {
    const caps = dealCapabilities(makeDealPurchaseRow({ refundedAt: null }), {
      ...NO_MONEY,
      vouchersVoidedAt: "2026-08-03T20:00:00.000Z",
    });
    expect(caps.find((c) => c.action === "void")?.blockedReason).toBe("Already voided.");
    expect(caps.find((c) => c.action === "refund")?.blockedReason).toBe(
      "Already voided on this purchase.",
    );
  });
});
