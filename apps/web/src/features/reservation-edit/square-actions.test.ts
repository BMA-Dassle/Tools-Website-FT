/**
 * refundTenderPartial — clamping to the un-refunded remainder, the
 * gift-card-tender skip (Square refuses partial refunds of GC-funded
 * payments, live finding 2026-07-11), and reason passthrough.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("~/features/cancellation/square-actions", () => ({
  fetchPaymentFacts: vi.fn(),
  fetchGiftCardFacts: vi.fn(),
  sq: vi.fn(),
}));

import { fetchPaymentFacts, sq } from "~/features/cancellation/square-actions";
import { fetchRefundFacts, refundTenderPartial } from "./square-actions";

const payment = (over: Record<string, unknown> = {}) => ({
  id: "PAY1",
  status: "COMPLETED",
  amountCents: 5000,
  refundedCents: 0,
  sourceType: "CARD",
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(sq).mockResolvedValue({
    ok: true,
    status: 200,
    json: { refund: { id: "RF1" } },
  } as never);
});

describe("refundTenderPartial", () => {
  it("refunds the requested amount with the given reason", async () => {
    vi.mocked(fetchPaymentFacts).mockResolvedValue(payment() as never);
    const r = await refundTenderPartial({
      editId: "edit-42-a1",
      refundIndex: 0,
      paymentId: "PAY1",
      amountCents: 500,
      reason: "Reservation Deposit",
    });
    expect(r).toEqual({ refundId: "RF1", refundedCents: 500 });
    expect(vi.mocked(sq)).toHaveBeenCalledWith(
      "POST",
      "/refunds",
      expect.objectContaining({
        idempotency_key: "edit-42-a1-r0",
        payment_id: "PAY1",
        amount_money: { amount: 500, currency: "USD" },
        reason: "Reservation Deposit",
      }),
    );
  });

  it("clamps to the un-refunded remainder", async () => {
    vi.mocked(fetchPaymentFacts).mockResolvedValue(
      payment({ amountCents: 5000, refundedCents: 4800 }) as never,
    );
    const r = await refundTenderPartial({
      editId: "edit-42-a1",
      refundIndex: 1,
      paymentId: "PAY1",
      amountCents: 500,
      reason: "Reservation Deposit",
    });
    expect(r.refundedCents).toBe(200);
  });

  it("no-ops on a fully refunded payment", async () => {
    vi.mocked(fetchPaymentFacts).mockResolvedValue(
      payment({ amountCents: 5000, refundedCents: 5000 }) as never,
    );
    const r = await refundTenderPartial({
      editId: "edit-42-a1",
      refundIndex: 2,
      paymentId: "PAY1",
      amountCents: 500,
      reason: "Reservation Deposit",
    });
    expect(r.refundedCents).toBe(0);
    expect(vi.mocked(sq)).not.toHaveBeenCalled();
  });

  it("skips a gift-card payment when the ask would be a PARTIAL refund", async () => {
    vi.mocked(fetchPaymentFacts).mockResolvedValue(payment({ sourceType: "GIFT_CARD" }) as never);
    const r = await refundTenderPartial({
      editId: "edit-42-a1",
      refundIndex: 3,
      paymentId: "PAY_GC",
      amountCents: 500, // < 5000 remaining → partial → Square would refuse
      reason: "Reservation Deposit",
      skipGiftCardTender: true,
    });
    expect(r).toEqual({ refundedCents: 0, skippedGiftCard: true });
    expect(vi.mocked(sq)).not.toHaveBeenCalled();
  });

  it("a FULL-remainder ask on a gift-card payment proceeds (full GC refunds are legal)", async () => {
    vi.mocked(fetchPaymentFacts).mockResolvedValue(
      payment({ sourceType: "GIFT_CARD", amountCents: 5000, refundedCents: 0 }) as never,
    );
    const r = await refundTenderPartial({
      editId: "edit-42-a1",
      refundIndex: 3,
      paymentId: "PAY_GC",
      amountCents: 5000, // covers the whole remainder → full refund
      reason: "Reservation Deposit",
      skipGiftCardTender: true,
    });
    expect(r).toEqual({ refundId: "RF1", refundedCents: 5000 });
    expect(vi.mocked(sq)).toHaveBeenCalled();
  });

  it("still refunds a gift-card payment when the caller did NOT opt into skipping", async () => {
    // The mid/post paths deliberately target GC tenders (known-invalid designs,
    // flag-gated) — the skip must be opt-in so their failures stay loud at
    // Square rather than silently refunding $0.
    vi.mocked(fetchPaymentFacts).mockResolvedValue(payment({ sourceType: "GIFT_CARD" }) as never);
    const r = await refundTenderPartial({
      editId: "edit-42-a1",
      refundIndex: 4,
      paymentId: "PAY_GC",
      amountCents: 500,
      reason: "Reservation Deposit",
    });
    expect(r.refundedCents).toBe(500);
    expect(vi.mocked(sq)).toHaveBeenCalled();
  });
});

describe("fetchRefundFacts", () => {
  it("parses payment id, amount, and status", async () => {
    vi.mocked(sq).mockResolvedValue({
      ok: true,
      status: 200,
      json: {
        refund: {
          id: "RF9",
          payment_id: "PAY1",
          amount_money: { amount: 300, currency: "USD" },
          status: "COMPLETED",
        },
      },
    } as never);
    await expect(fetchRefundFacts("RF9")).resolves.toEqual({
      paymentId: "PAY1",
      amountCents: 300,
      status: "COMPLETED",
    });
    expect(vi.mocked(sq)).toHaveBeenCalledWith("GET", "/refunds/RF9");
  });

  it("throws on a missing refund", async () => {
    vi.mocked(sq).mockResolvedValue({ ok: false, status: 404, json: {} } as never);
    await expect(fetchRefundFacts("RF_NOPE")).rejects.toThrow(/refund RF_NOPE fetch/);
  });
});
