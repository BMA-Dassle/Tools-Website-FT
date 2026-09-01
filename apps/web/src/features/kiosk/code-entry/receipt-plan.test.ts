import { describe, expect, it } from "vitest";
import { receiptPlan } from "./receipt-plan";

const base = { cardCodes: 0, canIssue: true, cartVouchers: 0, promoApplied: false };

describe("receiptPlan", () => {
  it("cards only, dispenser here → print, and Back warns", () => {
    expect(receiptPlan({ ...base, cardCodes: 2 })).toEqual({
      primary: "print",
      warnOnBack: true,
    });
  });

  it("cards + cart vouchers → print & continue, Back warns", () => {
    expect(receiptPlan({ ...base, cardCodes: 1, cartVouchers: 1 })).toEqual({
      primary: "print-continue",
      warnOnBack: true,
    });
  });

  it("cards + promo (no cart vouchers) → still print & continue", () => {
    expect(receiptPlan({ ...base, cardCodes: 1, promoApplied: true }).primary).toBe(
      "print-continue",
    );
  });

  it("cart vouchers only → start picking, no warning", () => {
    expect(receiptPlan({ ...base, cartVouchers: 2 })).toEqual({
      primary: "start-picking",
      warnOnBack: false,
    });
  });

  it("promo only → start picking, no warning", () => {
    expect(receiptPlan({ ...base, promoApplied: true }).primary).toBe("start-picking");
  });

  it("NO dispenser: cards never promise printing — cards-only reads done", () => {
    expect(receiptPlan({ ...base, cardCodes: 3, canIssue: false })).toEqual({
      primary: "done",
      warnOnBack: false,
    });
  });

  it("NO dispenser: cards + cart legs → start picking (order still real)", () => {
    expect(receiptPlan({ ...base, cardCodes: 1, cartVouchers: 1, canIssue: false }).primary).toBe(
      "start-picking",
    );
  });

  it("empty receipt → done", () => {
    expect(receiptPlan(base)).toEqual({ primary: "done", warnOnBack: false });
  });
});
