import { describe, expect, it } from "vitest";
import { DISABLE_AFTER_MS, isDueForDisable, legTerminalMs, MAX_DISABLE_ATTEMPTS } from "./data";
import type { DisableGroupLeg, SavedCardRow } from "./types";

/**
 * Pure due-for-disable predicate — every branch from
 * tasks/future/reservation-editing-plan.md §7 "Deletion" / §13.
 * The SQL shortlist prefilters row-local facts; this predicate is the final
 * authority the sweep runs against live reservation rows.
 */

const NOW = new Date("2026-07-11T12:00:00.000Z");
const HOURS = 60 * 60 * 1000;
const iso = (msBeforeNow: number): string => new Date(NOW.getTime() - msBeforeNow).toISOString();

const card = (partial: Partial<SavedCardRow> = {}): SavedCardRow => ({
  id: 1,
  squareCustomerId: "CUS_1",
  squareCardId: "ccof:CARD_1",
  cardBrand: "VISA",
  cardLast4: "4242",
  cardExpMonth: 12,
  cardExpYear: 2028,
  fingerprint: "fp_1",
  sourceReservationId: 4211,
  sourceDepositOrderId: "DEP_ORDER_1",
  sourcePaymentId: "PAY_1",
  weAdded: true,
  permanentConsent: false,
  consentSource: null,
  captureAttempts: 0,
  captureLastError: null,
  captureSkipReason: null,
  disabledAt: null,
  disableAttempts: 0,
  disableLastError: null,
  createdAt: iso(200 * HOURS),
  updatedAt: iso(200 * HOURS),
  ...partial,
});

const leg = (partial: Partial<DisableGroupLeg> = {}): DisableGroupLeg => ({
  status: "completed",
  bookedAt: iso(100 * HOURS), // well past the 72h window
  ...partial,
});

describe("isDueForDisable — happy path", () => {
  it("due: we_added, no consent, whole group terminal >72h, no live reservations", () => {
    expect(isDueForDisable(card(), [leg()], 0, NOW)).toBe(true);
  });

  it("due: multi-leg combo where EVERY leg is terminal >72h (completed + no_show)", () => {
    const group = [
      leg({ status: "completed", bookedAt: iso(90 * HOURS) }),
      leg({ status: "no_show", bookedAt: iso(80 * HOURS) }),
    ];
    expect(isDueForDisable(card(), group, 0, NOW)).toBe(true);
  });
});

describe("isDueForDisable — group-terminal branches", () => {
  it("NOT due: mixed-terminal combo — one leg completed, the other still live", () => {
    const group = [
      leg({ status: "completed", bookedAt: iso(90 * HOURS) }),
      leg({ status: "confirmed", bookedAt: iso(-24 * HOURS) }), // upcoming leg
    ];
    expect(isDueForDisable(card(), group, 0, NOW)).toBe(false);
  });

  it("NOT due: any non-terminal status blocks (arrived / confirm_pending / confirm_failed)", () => {
    for (const status of ["arrived", "confirm_pending", "confirm_failed"]) {
      expect(isDueForDisable(card(), [leg({ status })], 0, NOW)).toBe(false);
    }
  });

  it("NOT due: empty group (no reservation rows loaded — never guess)", () => {
    expect(isDueForDisable(card(), [], 0, NOW)).toBe(false);
  });
});

describe("isDueForDisable — 72h window", () => {
  it("NOT due: terminal but visit < 72h ago", () => {
    expect(isDueForDisable(card(), [leg({ bookedAt: iso(71 * HOURS) })], 0, NOW)).toBe(false);
  });

  it("due: terminal and visit > 72h ago", () => {
    expect(isDueForDisable(card(), [leg({ bookedAt: iso(73 * HOURS) })], 0, NOW)).toBe(true);
  });

  it("boundary: exactly 72h is NOT yet due", () => {
    expect(isDueForDisable(card(), [leg({ bookedAt: iso(DISABLE_AFTER_MS) })], 0, NOW)).toBe(false);
  });

  it("the LATEST leg drives the clock (one leg way past, one just under 72h)", () => {
    const group = [
      leg({ status: "completed", bookedAt: iso(300 * HOURS) }),
      leg({ status: "completed", bookedAt: iso(70 * HOURS) }),
    ];
    expect(isDueForDisable(card(), group, 0, NOW)).toBe(false);
  });

  it("race anchors: metadata heat times (not the early booked_at) drive the clock", () => {
    // Booked 2 weeks ago, but the heats ran < 72h ago → not due yet.
    const raceLeg = leg({
      status: "completed",
      bookedAt: iso(14 * 24 * HOURS),
      bookingMetadata: {
        heats: [{ heatId: iso(48 * HOURS) }, { heatId: iso(50 * HOURS) }],
      },
    });
    expect(isDueForDisable(card(), [raceLeg], 0, NOW)).toBe(false);
    // Same shape with heats > 72h ago → due.
    const oldRaceLeg = leg({
      status: "completed",
      bookedAt: iso(14 * 24 * HOURS),
      bookingMetadata: { heats: [{ heatId: iso(80 * HOURS) }] },
    });
    expect(isDueForDisable(card(), [oldRaceLeg], 0, NOW)).toBe(true);
  });
});

describe("isDueForDisable — cancelled groups", () => {
  it("due: cancelled-only group, cancelled > 72h ago (72h clock runs from cancellation)", () => {
    const cancelled = leg({
      status: "cancelled",
      bookedAt: iso(-7 * 24 * HOURS), // visit would have been next week
      cancelledAt: iso(80 * HOURS),
    });
    expect(isDueForDisable(card(), [cancelled], 0, NOW)).toBe(true);
  });

  it("NOT due: cancelled < 72h ago even when booked long ago", () => {
    const cancelled = leg({
      status: "cancelled",
      bookedAt: iso(500 * HOURS),
      cancelledAt: iso(10 * HOURS),
    });
    expect(isDueForDisable(card(), [cancelled], 0, NOW)).toBe(false);
  });
});

describe("isDueForDisable — row-local guards", () => {
  it("NOT due: permanent consent (checkout opt-in) is never auto-removed", () => {
    expect(
      isDueForDisable(
        card({ permanentConsent: true, consentSource: "checkout_optin" }),
        [leg()],
        0,
        NOW,
      ),
    ).toBe(false);
  });

  it("NOT due: we_added=false (pre-existing card — not ours to remove)", () => {
    expect(isDueForDisable(card({ weAdded: false }), [leg()], 0, NOW)).toBe(false);
  });

  it("NOT due: already disabled", () => {
    expect(isDueForDisable(card({ disabledAt: iso(HOURS) }), [leg()], 0, NOW)).toBe(false);
  });

  it("NOT due: capture never completed (no card id to disable)", () => {
    expect(isDueForDisable(card({ squareCardId: null }), [leg()], 0, NOW)).toBe(false);
  });

  it("NOT due: disable attempts exhausted", () => {
    expect(isDueForDisable(card({ disableAttempts: MAX_DISABLE_ATTEMPTS }), [leg()], 0, NOW)).toBe(
      false,
    );
    expect(
      isDueForDisable(card({ disableAttempts: MAX_DISABLE_ATTEMPTS - 1 }), [leg()], 0, NOW),
    ).toBe(true);
  });
});

describe("isDueForDisable — customer live-reservation deferral", () => {
  it("NOT due while the customer holds ANY other live reservation (its edit may need the card)", () => {
    expect(isDueForDisable(card(), [leg()], 1, NOW)).toBe(false);
    expect(isDueForDisable(card(), [leg()], 3, NOW)).toBe(false);
    expect(isDueForDisable(card(), [leg()], 0, NOW)).toBe(true);
  });
});

describe("legTerminalMs", () => {
  it("cancelled legs use cancelled_at; completed legs use booked_at", () => {
    const cancelledAt = iso(5 * HOURS);
    expect(
      legTerminalMs(leg({ status: "cancelled", bookedAt: iso(90 * HOURS), cancelledAt })),
    ).toBe(Date.parse(cancelledAt));
    const bookedAt = iso(90 * HOURS);
    expect(legTerminalMs(leg({ status: "completed", bookedAt }))).toBe(Date.parse(bookedAt));
  });

  it("attraction slot times from metadata extend the reference", () => {
    const slot = iso(10 * HOURS);
    const l = leg({
      bookedAt: iso(90 * HOURS),
      bookingMetadata: { attractions: [{ slug: "gel-blaster", slot, qty: 4 }] },
    });
    expect(legTerminalMs(l)).toBe(Date.parse(slot));
  });
});
