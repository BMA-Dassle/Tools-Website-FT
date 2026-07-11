import { describe, it, expect } from "vitest";
import { findExternalRefunds, isSanctionedRefund } from "./detect";
import type { RefundLite, ReservationLite } from "./detect";

const REFUND: RefundLite = {
  id: "ref_abc",
  paymentId: "pay_1",
  status: "COMPLETED",
  amountCents: 47690,
  reason: "Canceled order",
  createdAt: "2026-07-03T22:44:27.847Z",
  teamMemberId: "TM123",
};

const RES: ReservationLite = {
  id: 10286,
  guestName: "Joseph Andujar III",
  status: "confirmed",
  productKind: "race",
  centerCode: "fort-myers",
  totalCents: 47690,
  refundCents: 0,
  squareRefundId: null,
  qamfReservationId: null,
};

describe("isSanctionedRefund", () => {
  it("flags a Square-side refund on a live reservation as NOT sanctioned", () => {
    expect(isSanctionedRefund(REFUND, RES, new Set())).toBe(false);
  });

  it("quiet when the refund id is stamped on the reservation", () => {
    expect(isSanctionedRefund(REFUND, { ...RES, squareRefundId: "ref_abc" }, new Set())).toBe(true);
  });

  it("quiet when the cancel cascade recorded the refund id", () => {
    expect(isSanctionedRefund(REFUND, RES, new Set(["ref_abc"]))).toBe(true);
  });

  it("quiet on the legacy shape: cancelled with a recorded refund amount", () => {
    expect(
      isSanctionedRefund(REFUND, { ...RES, status: "cancelled", refundCents: 47690 }, new Set()),
    ).toBe(true);
  });

  it("still flags a cancelled reservation whose refund was never recorded", () => {
    expect(isSanctionedRefund(REFUND, { ...RES, status: "cancelled" }, new Set())).toBe(false);
  });
});

describe("findExternalRefunds", () => {
  const byPayment = new Map([["pay_1", RES]]);

  it("pairs refunds with reservations and keeps only external ones", () => {
    const out = findExternalRefunds([REFUND], byPayment, new Set());
    expect(out).toHaveLength(1);
    expect(out[0].reservation.id).toBe(10286);
  });

  it("ignores refunds on payments we do not know", () => {
    expect(findExternalRefunds([{ ...REFUND, paymentId: "pay_x" }], byPayment, new Set())).toEqual(
      [],
    );
  });

  it("ignores FAILED/REJECTED refunds — no money moved", () => {
    expect(findExternalRefunds([{ ...REFUND, status: "FAILED" }], byPayment, new Set())).toEqual(
      [],
    );
    expect(findExternalRefunds([{ ...REFUND, status: "REJECTED" }], byPayment, new Set())).toEqual(
      [],
    );
  });

  it("sorts oldest first", () => {
    const older = { ...REFUND, id: "ref_old", createdAt: "2026-07-01T00:00:00Z" };
    const out = findExternalRefunds([REFUND, older], byPayment, new Set());
    expect(out.map((e) => e.refund.id)).toEqual(["ref_old", "ref_abc"]);
  });
});
