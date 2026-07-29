import { describe, expect, it } from "vitest";
import type { BowlingReservation } from "@/lib/bowling-db";
import {
  SQUARE_TOKEN_CATALOG_ID,
  SQUARE_ACTIVATION_FEE_CATALOG_ID,
} from "~/features/game-cards/constants";
import {
  classifyMoney,
  eventStartEt,
  formatGan,
  gameZoneCents,
  guardActorOutcome,
  guardCustomerCutoff,
  guardDayofOrder,
  guardRefundTotal,
  legLabel,
  tenderRefundsNeeded,
  toEtWallClock,
} from "./guards";
import { CancelGuardError, type GatheredFacts } from "./types";

export function mkRes(over: Partial<BowlingReservation> = {}): BowlingReservation {
  return {
    id: 100,
    centerCode: "fort-myers",
    productKind: "open",
    depositCents: 5000,
    totalCents: 5000,
    status: "confirmed",
    qamfConfirmAttempts: 0,
    bookedAt: "2026-07-10T18:00:00.000Z",
    refundCents: 0,
    storeCreditCents: 0,
    rewardDiscountCents: 0,
    promoSavingsCents: 0,
    attractionBookings: [],
    insertedAt: "2026-07-01T00:00:00.000Z",
    ...over,
  };
}

function code(fn: () => void): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof CancelGuardError) return e.code;
    throw e;
  }
  return "no_throw";
}

describe("toEtWallClock", () => {
  it("converts a UTC instant to naive ET (EDT in July = UTC-4)", () => {
    expect(toEtWallClock(new Date("2026-07-03T16:00:00.000Z"))).toBe("2026-07-03T12:00:00");
  });
});

describe("eventStartEt", () => {
  it("uses the earliest heat for race rows (heatId is the naked-ET start)", () => {
    const r = mkRes({
      productKind: "race",
      bookedAt: "2026-07-01T00:00:00.000Z", // booking time — must be ignored
      bookingMetadata: {
        heats: [{ heatId: "2026-07-12T15:30:00" }, { heatId: "2026-07-12T14:15:00" }],
      },
    });
    expect(eventStartEt(r)).toBe("2026-07-12T14:15:00");
  });

  it("uses the earliest attraction slot", () => {
    const r = mkRes({
      productKind: "attraction",
      bookingMetadata: {
        attractions: [{ slot: "2026-07-12T17:00:00" }, { slot: "2026-07-12T16:00:00" }],
      },
    });
    expect(eventStartEt(r)).toBe("2026-07-12T16:00:00");
  });

  it("falls back to booked_at (as ET) for bowling", () => {
    // 18:00Z on 2026-07-10 (EDT) = 14:00 ET
    expect(eventStartEt(mkRes())).toBe("2026-07-10T14:00:00");
  });

  it("survives malformed metadata", () => {
    const r = mkRes({ productKind: "race", bookingMetadata: { heats: "junk" } as never });
    expect(eventStartEt(r)).toBe("2026-07-10T14:00:00");
  });
});

describe("guardCustomerCutoff", () => {
  // now = 2026-07-03T12:00:00Z = 08:00 ET (EDT)
  const nowMs = Date.parse("2026-07-03T12:00:00.000Z");

  it("throws within_1_hour for an event 30 minutes out", () => {
    const r = mkRes({
      productKind: "race",
      bookingMetadata: { heats: [{ heatId: "2026-07-03T08:30:00" }] },
    });
    expect(code(() => guardCustomerCutoff([r], nowMs))).toBe("within_1_hour");
  });

  it("passes for an event 90 minutes out", () => {
    const r = mkRes({
      productKind: "race",
      bookingMetadata: { heats: [{ heatId: "2026-07-03T09:30:00" }] },
    });
    expect(code(() => guardCustomerCutoff([r], nowMs))).toBe("no_throw");
  });

  it("uses the EARLIEST leg across the group", () => {
    const soon = mkRes({
      id: 1,
      productKind: "race",
      bookingMetadata: { heats: [{ heatId: "2026-07-03T08:15:00" }] },
    });
    const later = mkRes({ id: 2, bookedAt: "2026-07-04T18:00:00.000Z" });
    expect(code(() => guardCustomerCutoff([later, soon], nowMs))).toBe("within_1_hour");
  });
});

describe("guardActorOutcome", () => {
  it("admin can do anything, combos included", () => {
    expect(
      code(() => guardActorOutcome({ isCombo: true, actor: "admin", outcome: "refund" })),
    ).toBe("no_throw");
    expect(
      code(() => guardActorOutcome({ isCombo: true, actor: "admin", outcome: "store_credit" })),
    ).toBe("no_throw");
  });

  it("customers cannot touch combos at all", () => {
    expect(
      code(() => guardActorOutcome({ isCombo: true, actor: "customer", outcome: "store_credit" })),
    ).toBe("combo_requires_admin");
  });

  it("customer refunds are blocked unless the route allows the legacy bowling path", () => {
    expect(
      code(() => guardActorOutcome({ isCombo: false, actor: "customer", outcome: "refund" })),
    ).toBe("refund_requires_admin");
    expect(
      code(() =>
        guardActorOutcome({
          isCombo: false,
          actor: "customer",
          outcome: "refund",
          allowCustomerRefund: true,
        }),
      ),
    ).toBe("no_throw");
  });

  it("customer store-credit on a normal booking passes", () => {
    expect(
      code(() => guardActorOutcome({ isCombo: false, actor: "customer", outcome: "store_credit" })),
    ).toBe("no_throw");
  });
});

describe("classifyMoney", () => {
  it("funded when the group carries a gift card", () => {
    expect(
      classifyMoney([
        mkRes({ squareDepositPaymentId: "pay_1" }),
        mkRes({ id: 101, squareGiftCardId: "gftc:a" }),
      ]),
    ).toBe("funded");
  });
  it("zero when nothing was charged", () => {
    expect(classifyMoney([mkRes()])).toBe("zero");
  });
  it("broken when charged but no gift card anywhere", () => {
    expect(classifyMoney([mkRes({ squareDepositPaymentId: "pay_1" })])).toBe("broken");
  });
});

describe("guardDayofOrder", () => {
  it("refuses tendered orders regardless of state ('paid' is tenders, never state)", () => {
    expect(guardDayofOrder({ state: "OPEN", tenderCount: 1 })).toBe("refuse");
    expect(guardDayofOrder({ state: "COMPLETED", tenderCount: 2 })).toBe("refuse");
  });
  it("skips already-terminal orders", () => {
    expect(guardDayofOrder({ state: "CANCELED", tenderCount: 0 })).toBe("skip");
    expect(guardDayofOrder({ state: "COMPLETED", tenderCount: 0 })).toBe("skip");
  });
  it("cancels OPEN/DRAFT untendered orders", () => {
    expect(guardDayofOrder({ state: "OPEN", tenderCount: 0 })).toBe("cancel");
    expect(guardDayofOrder({ state: "DRAFT", tenderCount: 0 })).toBe("cancel");
  });
  it("refuses unexpected states", () => {
    expect(guardDayofOrder({ state: "WEIRD", tenderCount: 0 })).toBe("refuse");
  });
});

describe("tenderRefundsNeeded", () => {
  const facts = (payments: GatheredFacts["payments"]): GatheredFacts => ({
    payments,
    dayofOrders: {},
    depositOrder: {
      id: "dep_1",
      tenders: Object.values(payments).map((p) => ({
        paymentId: p.id,
        amountCents: p.amountCents,
      })),
    },
  });

  it("returns the unrefunded remainder per tender (exactly-once)", () => {
    const f = facts({
      pay_a: { id: "pay_a", status: "COMPLETED", amountCents: 10000, refundedCents: 0 },
      pay_b: { id: "pay_b", status: "COMPLETED", amountCents: 5000, refundedCents: 5000 },
      pay_c: { id: "pay_c", status: "COMPLETED", amountCents: 4000, refundedCents: 1500 },
    });
    expect(tenderRefundsNeeded(f)).toEqual([
      { paymentId: "pay_a", amountCents: 10000 },
      { paymentId: "pay_c", amountCents: 2500 },
    ]);
  });

  it("throws amount_mismatch when a tender's payment could not be fetched", () => {
    const f = facts({});
    f.depositOrder!.tenders = [{ paymentId: "pay_missing", amountCents: 100 }];
    expect(code(() => tenderRefundsNeeded(f))).toBe("amount_mismatch");
  });

  describe("Game Zone exclusion", () => {
    it("caps the single reader tender by the gz total (deposit stays refundable)", () => {
      const f = facts({
        pay_1: {
          id: "pay_1",
          status: "COMPLETED",
          amountCents: 7410,
          refundedCents: 0,
          sourceType: "CARD",
        },
      });
      f.depositOrder!.gameZoneCents = 700;
      expect(tenderRefundsNeeded(f)).toEqual([
        { paymentId: "pay_1", amountCents: 6710, partial: true },
      ]);
    });

    it("drops the tender entirely when the exclusion covers the whole remainder (resume after refund)", () => {
      // Prior attempt refunded the deposit; the remainder IS the gz money.
      const f = facts({
        pay_1: {
          id: "pay_1",
          status: "COMPLETED",
          amountCents: 7410,
          refundedCents: 6710,
          sourceType: "CARD",
        },
      });
      f.depositOrder!.gameZoneCents = 700;
      expect(tenderRefundsNeeded(f)).toEqual([]);
    });

    it("never lands the exclusion on a GIFT_CARD-funded or edit-topup tender", () => {
      const f: GatheredFacts = {
        dayofOrders: {},
        payments: {
          pay_gc: {
            id: "pay_gc",
            status: "COMPLETED",
            amountCents: 2000,
            refundedCents: 0,
            sourceType: "GIFT_CARD",
          },
          pay_card: {
            id: "pay_card",
            status: "COMPLETED",
            amountCents: 5410,
            refundedCents: 0,
            sourceType: "CARD",
          },
          pay_edit: {
            id: "pay_edit",
            status: "COMPLETED",
            amountCents: 1000,
            refundedCents: 0,
            sourceType: "CARD",
          },
        },
        depositOrder: {
          id: "dep_1",
          gameZoneCents: 700,
          tenders: [
            { paymentId: "pay_gc", amountCents: 2000 },
            { paymentId: "pay_card", amountCents: 5410 },
            { paymentId: "pay_edit", amountCents: 1000, editTopup: true },
          ],
        },
      };
      expect(tenderRefundsNeeded(f)).toEqual([
        { paymentId: "pay_gc", amountCents: 2000 },
        { paymentId: "pay_card", amountCents: 4710, partial: true },
        { paymentId: "pay_edit", amountCents: 1000 },
      ]);
    });

    it("leaves un-allocatable exclusion in the sum (fail-closed via guardRefundTotal)", () => {
      // Only a GIFT_CARD tender is available — the exclusion cannot land, so
      // the refundable total stays gz-inflated and the balance guard trips.
      const f = facts({
        pay_gc: {
          id: "pay_gc",
          status: "COMPLETED",
          amountCents: 7410,
          refundedCents: 0,
          sourceType: "GIFT_CARD",
        },
      });
      f.depositOrder!.gameZoneCents = 700;
      const needed = tenderRefundsNeeded(f);
      expect(needed).toEqual([{ paymentId: "pay_gc", amountCents: 7410 }]);
      const neededCents = needed.reduce((s, r) => s + r.amountCents, 0);
      expect(
        code(() => guardRefundTotal({ refundsNeededCents: neededCents, gcBalanceCents: 6710 })),
      ).toBe("amount_mismatch");
    });

    it("genuine partial redemption still trips the balance guard after gz exclusion", () => {
      const f = facts({
        pay_1: {
          id: "pay_1",
          status: "COMPLETED",
          amountCents: 7410,
          refundedCents: 0,
          sourceType: "CARD",
        },
      });
      f.depositOrder!.gameZoneCents = 700;
      const neededCents = tenderRefundsNeeded(f).reduce((s, r) => s + r.amountCents, 0);
      // Card was partially spent at the venue: balance 6000 ≠ refundable 6710.
      expect(
        code(() => guardRefundTotal({ refundsNeededCents: neededCents, gcBalanceCents: 6000 })),
      ).toBe("amount_mismatch");
    });
  });
});

describe("gameZoneCents", () => {
  it("sums token + activation-fee lines by catalog id (totals are quantity-inclusive)", () => {
    expect(
      gameZoneCents([
        { totalCents: 6710 }, // the deposit line — no catalog id, never counted
        { catalogObjectId: SQUARE_TOKEN_CATALOG_ID, totalCents: 500 },
        { catalogObjectId: SQUARE_TOKEN_CATALOG_ID, totalCents: 1000 },
        { catalogObjectId: SQUARE_ACTIVATION_FEE_CATALOG_ID, totalCents: 400 }, // qty 2 × $2
      ]),
    ).toBe(1900);
  });

  it("ignores unrelated catalog ids and missing input", () => {
    expect(gameZoneCents([{ catalogObjectId: "SOMETHING_ELSE", totalCents: 999 }])).toBe(0);
    expect(gameZoneCents([])).toBe(0);
    expect(gameZoneCents(undefined)).toBe(0);
  });
});

describe("guardRefundTotal", () => {
  it("passes when refundable total equals the gift-card balance", () => {
    expect(code(() => guardRefundTotal({ refundsNeededCents: 7500, gcBalanceCents: 7500 }))).toBe(
      "no_throw",
    );
  });
  it("throws amount_mismatch otherwise (partial redemption / manual activity)", () => {
    expect(code(() => guardRefundTotal({ refundsNeededCents: 7500, gcBalanceCents: 7000 }))).toBe(
      "amount_mismatch",
    );
  });
});

describe("formatGan / legLabel", () => {
  it("groups a GAN in fours for display", () => {
    expect(formatGan("7783320012345678")).toBe("7783-3200-1234-5678");
    expect(formatGan("12345")).toBe("1234-5");
  });
  it("labels legs for guests/staff", () => {
    expect(legLabel(mkRes({ productKind: "race" }))).toBe("Karting");
    expect(legLabel(mkRes({ productKind: "kbf" }))).toBe("Kids Bowl Free");
    expect(legLabel(mkRes())).toBe("Bowling");
    expect(
      legLabel(
        mkRes({
          productKind: "attraction",
          bookingMetadata: { attractions: [{ name: "Gel Blaster", slot: "x" }] },
        }),
      ),
    ).toBe("Gel Blaster");
  });
});
