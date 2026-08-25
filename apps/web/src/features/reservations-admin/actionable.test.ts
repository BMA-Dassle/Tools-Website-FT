import { describe, expect, it } from "vitest";

import { cancelActionable, refundActionable } from "./actionable";
import type { Reservation } from "./types";

/** Minimal board row — only the fields the gates read carry meaning. */
const row = (over: Partial<Reservation> = {}): Reservation =>
  ({
    id: 16426,
    centerCode: "fort-myers",
    productKind: "race",
    status: "confirmed",
    bookedAt: "2026-07-26T18:10:50.676Z",
    depositCents: 2767,
    totalCents: 2767,
    refundCents: 0,
    rewardDiscountCents: 0,
    promoSavingsCents: 0,
    ...over,
  }) as Reservation;

const TERMINAL = ["arrived", "completed", "no_show"] as const;
const LIVE = ["confirmed", "confirm_pending", "confirm_failed"] as const;

describe("refundActionable", () => {
  it("offers a refund on the settled rows Cancel refuses", () => {
    // The reservation from the report: a completed race whose venue charge
    // landed. Cancel is gone here by design, so Refund is the only money door.
    for (const status of TERMINAL) {
      expect(
        refundActionable(row({ status, dayofPaymentId: "PLYFtcPwhP4zlqnNXRX7rJleWnMZY" })),
      ).toBe(true);
    }
  });

  it("stays out of Cancel's territory before the visit starts", () => {
    for (const status of LIVE) {
      expect(refundActionable(row({ status, dayofPaymentId: "PAY1" }))).toBe(false);
    }
  });

  it("needs a day-of charge to refund", () => {
    // No venue payment means no paid order for an itemized return to target —
    // a no-show that never got charged has nothing to give back.
    expect(refundActionable(row({ status: "no_show" }))).toBe(false);
    expect(refundActionable(row({ status: "completed", dayofPaymentId: undefined }))).toBe(false);
  });

  it("never offers a refund on a cancelled row", () => {
    // The cancel cascade already settled it; a second path would double-refund.
    expect(refundActionable(row({ status: "cancelled", dayofPaymentId: "PAY1" }))).toBe(false);
    expect(refundActionable(row({ status: "cancelled", groupHasDayofPayment: true }))).toBe(false);
  });

  it("offers a refund on the NON-paying leg of a shared day-of order", () => {
    // Res 24493 (attraction) shares one order with 24492 (open); only the
    // bowling leg carries dayof_payment_id. Staff opening the attraction leg
    // saw no Refund button and fell into Edit, which died mid-cascade.
    for (const status of TERMINAL) {
      expect(
        refundActionable(
          row({
            status,
            productKind: "attraction",
            dayofPaymentId: undefined,
            groupHasDayofPayment: true,
          }),
        ),
      ).toBe(true);
    }
    // The sibling's payment does not un-hide Refund before the visit starts.
    for (const status of LIVE) {
      expect(refundActionable(row({ status, groupHasDayofPayment: true }))).toBe(false);
    }
  });

  it("is mutually exclusive with Cancel for every status", () => {
    // The two share the red slot in the action bar. If both could ever show,
    // staff would have to guess which one settles money correctly.
    for (const status of [...TERMINAL, ...LIVE, "cancelled"] as const) {
      for (const dayofPaymentId of [undefined, "PAY1"]) {
        for (const groupHasDayofPayment of [false, true]) {
          const r = row({ status, dayofPaymentId, groupHasDayofPayment });
          expect(refundActionable(r) && cancelActionable(r)).toBe(false);
        }
      }
    }
  });
});
