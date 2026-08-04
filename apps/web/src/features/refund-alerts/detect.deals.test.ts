/**
 * Deal-pack refund detection — tested in BOTH directions.
 *
 * A watchdog that never fires and a watchdog that always fires look identical
 * from a single test, so every case here has its opposite.
 */
import { describe, expect, it } from "vitest";
import {
  findExternalDealRefunds,
  isSanctionedDealRefund,
  type DealPurchaseLite,
  type RefundLite,
} from "./detect";

const refund = (patch: Partial<RefundLite> = {}): RefundLite => ({
  id: "RFND1",
  paymentId: "PAY123",
  status: "COMPLETED",
  amountCents: 3621,
  reason: null,
  createdAt: "2026-08-04T12:00:00.000Z",
  teamMemberId: null,
  ...patch,
});

const purchase = (patch: Partial<DealPurchaseLite> = {}): DealPurchaseLite => ({
  id: 412,
  buyerName: "Jacob Elliott",
  buyerEmail: "jacob@headpinz.com",
  dealSlug: "laser-tag-game-card-pack",
  totalCents: 3621,
  refundedCents: 0,
  ...patch,
});

const byPayment = (p = purchase()) => new Map([["PAY123", p]]);

describe("isSanctionedDealRefund", () => {
  it("is sanctioned when we recorded the id", () => {
    expect(isSanctionedDealRefund(refund(), new Set(["RFND1"]))).toBe(true);
  });

  it("is NOT sanctioned when we did not", () => {
    expect(isSanctionedDealRefund(refund(), new Set())).toBe(false);
  });

  it("has no legacy fallback — a refunded amount alone never excuses it", () => {
    // Unlike the reservation rail, the deal ledger exists from day one, so
    // "we did this" is always answerable exactly. A heuristic here would only
    // create a way for a real Dashboard refund to pass as ours.
    const alreadyRefunded = purchase({ refundedCents: 3621 });
    const out = findExternalDealRefunds([refund()], byPayment(alreadyRefunded), new Set());
    expect(out).toHaveLength(1);
  });
});

describe("findExternalDealRefunds", () => {
  it("FLAGS a Dashboard refund on a deal payment", () => {
    // The hole this closes: before this existed, a deal payment matched no
    // subject and the refund was dropped as "not one of ours".
    const out = findExternalDealRefunds([refund()], byPayment(), new Set());
    expect(out).toHaveLength(1);
    expect(out[0].purchase.id).toBe(412);
    expect(out[0].refund.id).toBe("RFND1");
  });

  it("STAYS QUIET about a refund the board issued", () => {
    const out = findExternalDealRefunds([refund()], byPayment(), new Set(["RFND1"]));
    expect(out).toEqual([]);
  });

  it("ignores a refund on a payment that is not a deal purchase", () => {
    const out = findExternalDealRefunds([refund({ paymentId: "OTHER" })], byPayment(), new Set());
    expect(out).toEqual([]);
  });

  it("ignores failed and rejected refunds — no money moved", () => {
    const out = findExternalDealRefunds(
      [refund({ id: "A", status: "FAILED" }), refund({ id: "B", status: "REJECTED" })],
      byPayment(),
      new Set(),
    );
    expect(out).toEqual([]);
  });

  it("orders oldest first so the chat reads in sequence", () => {
    const out = findExternalDealRefunds(
      [
        refund({ id: "NEW", createdAt: "2026-08-04T13:00:00.000Z" }),
        refund({ id: "OLD", createdAt: "2026-08-04T11:00:00.000Z" }),
      ],
      byPayment(),
      new Set(),
    );
    expect(out.map((e) => e.refund.id)).toEqual(["OLD", "NEW"]);
  });

  it("does nothing when there are no deal purchases to match", () => {
    expect(findExternalDealRefunds([refund()], new Map(), new Set())).toEqual([]);
  });
});
