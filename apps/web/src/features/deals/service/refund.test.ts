/**
 * The executor.
 *
 * The single most important assertion in this file is the FIRST one: the leg
 * hold happens before any `/refunds` call. That ordering is what stands between
 * a guest scanning mid-refund and us paying for the same value twice.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  claimVoucher: vi.fn(),
  releaseVoucherClaim: vi.fn(),
  markVoucherClaimSpent: vi.fn(),
  voidNativeVoucher: vi.fn(),
  insertDealRefund: vi.fn(),
  updateDealRefund: vi.fn(),
  recomputeDealRefundTotals: vi.fn(),
}));

vi.mock("~/features/game-cards/data/voucher-claims-db", () => ({
  claimVoucher: mocks.claimVoucher,
  releaseVoucherClaim: mocks.releaseVoucherClaim,
  markVoucherClaimSpent: mocks.markVoucherClaimSpent,
}));
vi.mock("~/features/game-cards/service/native-voucher", () => ({
  voidNativeVoucher: mocks.voidNativeVoucher,
}));
vi.mock("../data/deal-refunds-db", () => ({
  insertDealRefund: mocks.insertDealRefund,
  updateDealRefund: mocks.updateDealRefund,
  recomputeDealRefundTotals: mocks.recomputeDealRefundTotals,
}));

const { DRIFT_TOLERANCE_CENTS, DealRefundError, executeDealRefund } = await import("./refund");
const { makeDealPurchaseRow } = await import("~/features/web-sales/test-support");

/** Call order across every mock, so relative ordering can be asserted. */
const calls: string[] = [];
const track = <T>(name: string, fn: () => T): T => {
  calls.push(name);
  return fn();
};

interface ReturnOrderArgs {
  editId: string;
  sourceOrderId: string;
  locationId: string;
  lines: Array<{ uid: string; quantity: number }>;
  seq?: number;
}
interface RefundArgs {
  editId: string;
  refundIndex: number;
  paymentId: string;
  amountCents: number;
  reason: string;
  returnOrderId?: string;
  skipGiftCardTender?: boolean;
}
interface ReturnOrderResult {
  returnOrderId: string;
  returnTotalCents: number;
}
interface RefundResult {
  refundId?: string;
  refundedCents: number;
}
interface GiftCardCreateArgs {
  locationId: string;
  idempotencyKey: string;
}
interface GiftCardRefundArgs {
  idempotencyKey: string;
  paymentId: string;
  destinationGiftCardId: string;
  amountCents: number;
  reason: string;
}

function deps(patch: Record<string, unknown> = {}) {
  return {
    // Typed via vi.fn's generic so `.mock.calls[0][0]` is checked — an untyped
    // spy turns every argument assertion below into a silent `any`.
    createReturnOrder: vi.fn<(a: ReturnOrderArgs) => Promise<ReturnOrderResult>>(async () =>
      track("return_order", () => ({ returnOrderId: "RET1", returnTotalCents: 3621 })),
    ),
    refundTenderPartial: vi.fn<(a: RefundArgs) => Promise<RefundResult>>(async () =>
      track("refund", () => ({ refundId: "RFND1", refundedCents: 3621 })),
    ),
    createDigitalGiftCard: vi.fn<(a: GiftCardCreateArgs) => Promise<{ id: string; gan: string }>>(
      async () => track("mint_gc", () => ({ id: "GC1", gan: "7783320012345678" })),
    ),
    refundToGiftCard: vi.fn<
      (a: GiftCardRefundArgs) => Promise<{ refundId: string; status: string }>
    >(async () => track("refund", () => ({ refundId: "RFND1", status: "PENDING" }))),
    giftCardBalanceCents: vi.fn(async () => 3621),
    locationIdFor: () => "LOC1",
    lineUidFor: async () => "LINE1",
    legsForPacks: () => [{ code: "HPWAAA", legIndexes: [0, 1, 2, 3] }],
    remainingPacksForCode: () => 0,
    ...patch,
  };
}

const plan = (patch: Record<string, unknown> = {}) =>
  ({
    destination: "card",
    selectedPackIndexes: [0],
    selectedTotalCents: 3621,
    planHash: "h".repeat(64),
    ...patch,
  }) as never;

const run = (patch: Record<string, unknown> = {}) =>
  executeDealRefund({
    row: makeDealPurchaseRow(),
    plan: plan(),
    reason: "bought twice",
    actor: "admin",
    override: false,
    deps: deps(),
    ...patch,
  } as never);

beforeEach(() => {
  vi.clearAllMocks();
  calls.length = 0;
  mocks.claimVoucher.mockImplementation(async () => track("hold", () => ({ ok: true, claim: {} })));
  mocks.releaseVoucherClaim.mockImplementation(async () => track("release", () => undefined));
  mocks.markVoucherClaimSpent.mockResolvedValue(true);
  mocks.voidNativeVoucher.mockResolvedValue(undefined);
  mocks.updateDealRefund.mockResolvedValue(undefined);
  mocks.recomputeDealRefundTotals.mockResolvedValue(undefined);
  mocks.insertDealRefund.mockImplementation(async (a: never) => ({
    id: 7,
    // Exercise the real key derivation rather than a stand-in.
    refundKey: (a as { refundKeyFor: (n: number) => string }).refundKeyFor(1),
    holdTxnId: "dealrf-0123456789abcdef-rf1",
    seq: 1,
  }));
});

describe("ordering", () => {
  it("freezes the legs BEFORE any money moves", async () => {
    // The assertion the whole design rests on. If a refund ever reaches Square
    // before the legs are held, a guest can redeem in that window and we pay for
    // the same value twice, permanently.
    await run();
    expect(calls.indexOf("hold")).toBeGreaterThanOrEqual(0);
    expect(calls.indexOf("hold")).toBeLessThan(calls.indexOf("refund"));
    expect(calls.indexOf("hold")).toBeLessThan(calls.indexOf("return_order"));
  });

  it("writes the ledger row before it holds anything", async () => {
    await run();
    expect(mocks.insertDealRefund).toHaveBeenCalledOnce();
    expect(mocks.insertDealRefund.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.claimVoucher.mock.invocationCallOrder[0],
    );
  });

  it("burns the holds only AFTER the money moved", async () => {
    await run();
    expect(mocks.markVoucherClaimSpent).toHaveBeenCalledWith("HPWAAA", "dealrf-0123456789abcdef-rf1");
    expect(calls.indexOf("refund")).toBeLessThan(
      mocks.markVoucherClaimSpent.mock.invocationCallOrder[0],
    );
  });
});

describe("a leg redeemed mid-refund", () => {
  it("aborts before any money moves and releases what it held", async () => {
    let n = 0;
    mocks.claimVoucher.mockImplementation(async () =>
      track("hold", () => (++n === 3 ? { ok: false, reason: "already_claimed" } : { ok: true, claim: {} })),
    );
    const d = deps();
    await expect(run({ deps: d })).rejects.toThrow(DealRefundError);
    expect(d.refundTenderPartial).not.toHaveBeenCalled();
    expect(d.createReturnOrder).not.toHaveBeenCalled();
    // The two it did win must go back, or those legs are frozen forever.
    expect(mocks.releaseVoucherClaim).toHaveBeenCalledTimes(1);
    expect(mocks.updateDealRefund).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ state: "failed" }),
    );
  });
});

describe("card destination", () => {
  it("itemizes through a return order and refunds against it", async () => {
    const d = deps();
    await run({ deps: d });
    expect(d.createReturnOrder).toHaveBeenCalledWith(
      expect.objectContaining({ sourceOrderId: "ORDER123", lines: [{ uid: "LINE1", quantity: 1 }] }),
    );
    expect(d.refundTenderPartial).toHaveBeenCalledWith(
      expect.objectContaining({ returnOrderId: "RET1", reason: "Refund: Deal Pack" }),
    );
  });

  it("prefers Square's computed total over our quote inside tolerance", async () => {
    const d = deps({
      createReturnOrder: vi.fn<(a: ReturnOrderArgs) => Promise<ReturnOrderResult>>(async () =>
        track("return_order", () => ({ returnOrderId: "RET1", returnTotalCents: 3622 })),
      ),
    });
    const res = await run({ deps: d });
    expect(d.refundTenderPartial.mock.calls[0][0].amountCents).toBe(3622);
    expect(res.warnings.join(" ")).toMatch(/Square's computed total/);
  });

  it("refuses WITHOUT refunding when the drift exceeds tolerance", async () => {
    const d = deps({
      createReturnOrder: vi.fn<(a: ReturnOrderArgs) => Promise<ReturnOrderResult>>(async () =>
        track("return_order", () => ({
          returnOrderId: "RET1",
          returnTotalCents: 3621 + DRIFT_TOLERANCE_CENTS + 1,
        })),
      ),
    });
    await expect(run({ deps: d })).rejects.toThrow(/re-plan/);
    // Never refund more than the modal displayed.
    expect(d.refundTenderPartial).not.toHaveBeenCalled();
    expect(mocks.releaseVoucherClaim).toHaveBeenCalled();
  });

  it("persists the Square refund id before it resolves", async () => {
    await run();
    expect(mocks.updateDealRefund).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ squareRefundId: "RFND1" }),
    );
  });
});

describe("gift-card destination", () => {
  const gcPlan = plan({ destination: "gift_card" });

  it("mints a fresh card and credits it cross-tender", async () => {
    const d = deps();
    const res = await run({ plan: gcPlan, deps: d });
    expect(d.createDigitalGiftCard).toHaveBeenCalledOnce();
    expect(d.refundToGiftCard).toHaveBeenCalledWith(
      expect.objectContaining({ destinationGiftCardId: "GC1", reason: "Refund: Deal Pack" }),
    );
    expect(res.giftCard).toEqual({ giftCardId: "GC1", gan: "7783320012345678" });
  });

  it("never uses the comp-mint helper, which would ALSO load a comped balance", async () => {
    const d = deps();
    await run({ plan: gcPlan, deps: d });
    expect(d.createReturnOrder).not.toHaveBeenCalled();
    expect(d.refundTenderPartial).not.toHaveBeenCalled();
  });

  it("treats an unconfirmed credit as pending, not failed, and does not re-refund", async () => {
    // Square posts gift-card credits in batch; a live smoke showed one at
    // PENDING while the money was already on the card. Re-refunding here is how
    // you pay twice.
    const d = deps({ giftCardBalanceCents: vi.fn(async () => 0) });
    const res = await run({ plan: gcPlan, deps: d });
    expect(res.creditPending).toBe(true);
    expect(d.refundToGiftCard).toHaveBeenCalledOnce();
    expect(mocks.updateDealRefund).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ state: "settled" }),
    );
  });
});

describe("aftermath", () => {
  it("voids a code once the purchase keeps no packs on it", async () => {
    const res = await run();
    expect(mocks.voidNativeVoucher).toHaveBeenCalledWith("HPWAAA", "deal refund #7");
    expect(res.voidedCodes).toEqual(["HPWAAA"]);
  });

  it("leaves a partly-refunded code alone", async () => {
    // Voiding a combined code whose other packs were kept destroys value the
    // guest still owns.
    const res = await run({ deps: deps({ remainingPacksForCode: () => 1 }) });
    expect(mocks.voidNativeVoucher).not.toHaveBeenCalled();
    expect(res.voidedCodes).toEqual([]);
  });

  it("still settles when the void fails, and says so", async () => {
    mocks.voidNativeVoucher.mockRejectedValue(new Error("neon down"));
    const res = await run();
    expect(res.warnings.join(" ")).toMatch(/could not be voided/);
    expect(mocks.updateDealRefund).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ state: "settled" }),
    );
  });

  it("recomputes the purchase projection from the ledger rather than incrementing", async () => {
    await run();
    expect(mocks.recomputeDealRefundTotals).toHaveBeenCalledWith(412);
  });
});

describe("keys", () => {
  it("derives every Square key from the purchase's own idempotency key", async () => {
    const d = deps();
    await run({ deps: d });
    expect(d.createReturnOrder.mock.calls[0][0].editId).toBe("0123456789abcdef-rf1");
    expect(d.refundTenderPartial.mock.calls[0][0].editId).toBe("0123456789abcdef-rf1");
  });

  it("namespaces the gift-card calls apart from the card ones", async () => {
    const d = deps();
    await run({ plan: plan({ destination: "gift_card" }), deps: d });
    expect(d.createDigitalGiftCard.mock.calls[0][0].idempotencyKey).toBe(
      "deal-gcd-0123456789abcdef-rf1",
    );
    expect(d.refundToGiftCard.mock.calls[0][0].idempotencyKey).toBe(
      "deal-gcr-0123456789abcdef-rf1",
    );
  });
});
