/**
 * KioskAmbientCheckout's pure decision logic — every branch that decides what
 * the pay screen does next, tested without a DOM: poll classification
 * (captured / partial / canceled / pending), the cap guards, what a CANCELED
 * signal means (self-dismiss vs guest-X vs walk-out), the 180s deadline rule,
 * and the SplitError→copy mapping.
 */
import { describe, expect, it } from "vitest";
import {
  afterCancelSignal,
  afterDeadline,
  canAddGiftCard,
  classifyPoll,
  errorKeyForCode,
} from "./ambient-checkout-machine";
import type { BoardTender } from "./client";

const gc = (n: number): BoardTender => ({
  kind: "gift_card",
  isGiftCard: true,
  paymentId: `gc_${n}`,
  last4: "1234",
  amountCents: 500,
});
const card = (n: number): BoardTender => ({
  kind: "terminal",
  isGiftCard: false,
  paymentId: `card_${n}`,
  last4: "9876",
  amountCents: 500,
});
const swipedGc = (n: number): BoardTender => ({
  kind: "terminal",
  isGiftCard: true, // brand SQUARE_GIFT_CARD swiped at the reader
  paymentId: `sw_${n}`,
  last4: "5555",
  amountCents: 500,
});

describe("classifyPoll", () => {
  it("captured: COMPLETED + captured + payment set", () => {
    expect(
      classifyPoll({
        status: "COMPLETED",
        captured: true,
        paymentIds: ["a", "b"],
        primaryPaymentId: "b",
      }),
    ).toEqual({ kind: "captured", paymentIds: ["a", "b"], primaryPaymentId: "b" });
  });

  it("captured without an explicit primary falls back to the first id", () => {
    expect(classifyPoll({ status: "COMPLETED", captured: true, paymentIds: ["a"] })).toEqual({
      kind: "captured",
      paymentIds: ["a"],
      primaryPaymentId: "a",
    });
  });

  it("partial: COMPLETED + captured:false + remainder", () => {
    const tenders = [swipedGc(1)];
    expect(
      classifyPoll({ status: "COMPLETED", captured: false, remainingCents: 1_500, tenders }),
    ).toEqual({ kind: "partial", remainingCents: 1_500, tenders });
  });

  it("canceled maps through; everything ambiguous is pending", () => {
    expect(classifyPoll({ status: "CANCELED" })).toEqual({ kind: "canceled" });
    expect(classifyPoll({ status: "PENDING" })).toEqual({ kind: "pending" });
    expect(classifyPoll({ status: "IN_PROGRESS", verifyPending: true })).toEqual({
      kind: "pending",
    });
    // COMPLETED but captured:true with NO ids (lagging read) must not finish.
    expect(classifyPoll({ status: "COMPLETED", captured: true, paymentIds: [] })).toEqual({
      kind: "pending",
    });
    // Legacy shape (no captured field at all) is pending, never a false finish.
    expect(classifyPoll({ status: "COMPLETED", paymentIds: ["a"] })).toEqual({ kind: "pending" });
  });
});

describe("canAddGiftCard (3 GC / 5 tenders)", () => {
  it("counts terminal-swiped gift cards toward the GC cap", () => {
    expect(canAddGiftCard([gc(1), swipedGc(2), swipedGc(3)])).toBe("gc-limit");
    expect(canAddGiftCard([gc(1), swipedGc(2)])).toBe("ok");
  });

  it("caps total tenders even when the GC cap has room", () => {
    expect(canAddGiftCard([gc(1), gc(2), card(1), card(2), card(3)])).toBe("tender-limit");
  });

  it("empty board is ok", () => {
    expect(canAddGiftCard([])).toBe("ok");
  });
});

describe("afterCancelSignal", () => {
  it("ignores our own dismiss (scan-apply / re-arm in flight)", () => {
    expect(afterCancelSignal({ selfDismissed: true, tenderCount: 2 })).toBe("ignore");
    expect(afterCancelSignal({ selfDismissed: true, tenderCount: 0 })).toBe("ignore");
  });

  it("re-arms when money is applied — the reader X must not strand a half-paid board", () => {
    expect(afterCancelSignal({ selfDismissed: false, tenderCount: 1 })).toBe("rearm");
  });

  it("exits on an empty board (today's semantics)", () => {
    expect(afterCancelSignal({ selfDismissed: false, tenderCount: 0 })).toBe("exit");
  });
});

describe("afterDeadline", () => {
  it("re-arms with tenders applied, exits on an empty board", () => {
    expect(afterDeadline(1)).toBe("rearm");
    expect(afterDeadline(0)).toBe("exit");
  });
});

describe("errorKeyForCode", () => {
  it("maps caps, lookups, capture-shaped and unknown codes", () => {
    expect(errorKeyForCode("gc-limit")).toBe("giftcard.limitReached");
    expect(errorKeyForCode("tender-limit")).toBe("giftcard.limitReached");
    expect(errorKeyForCode("card-unusable")).toBe("giftcard.err.lookup");
    expect(errorKeyForCode("zero-balance")).toBe("giftcard.err.lookup");
    expect(errorKeyForCode("token-invalid")).toBe("giftcard.err.lookup");
    expect(errorKeyForCode("sum-mismatch")).toBe("giftcard.err.capture");
    expect(errorKeyForCode("busy")).toBe("giftcard.err.apply");
    expect(errorKeyForCode(undefined)).toBe("giftcard.err.apply");
  });
});
