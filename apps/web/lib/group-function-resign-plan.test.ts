import { describe, it, expect } from "vitest";
import { resignPlan, type ResignPlanFacts } from "@/lib/group-function-resign-plan";

/**
 * The fixtures are real rows.
 *
 * C31E3AEC — quote 230, "Strikes for Scholarships" (FGCU, HeadPinz Fort Myers). Signed
 * 2026-07-01, post-paid: approval_required = true, deposit_due_cents = 0,
 * collected_cents = 0, balance_paid_at NULL, saved_card_id NULL, total $8,538.84.
 * HeadPinz invoices this account; it will never have a card on file.
 *
 * PAID_IN_FULL — the shape a price-change re-sign usually lands on: balance charged, a
 * card saved during the deposit, and a re-price that now owes a delta.
 */
const C31E3AEC: ResignPlanFacts = {
  status: "resign_required",
  depositPaidAt: "2026-07-01T13:06:43.821Z",
  balancePaidAt: null,
  totalCents: 853884,
  collectedCents: 0,
  hasCardOnFile: false,
};

const PAID_IN_FULL: ResignPlanFacts = {
  status: "resign_required",
  depositPaidAt: "2026-08-02T15:00:00.000Z",
  balancePaidAt: "2026-09-08T15:00:00.000Z",
  totalCents: 204288,
  collectedCents: 184325,
  hasCardOnFile: true,
};

describe("resignPlan", () => {
  it("REGRESSION: a post-paid re-sign never asks for a card", () => {
    // The bug: needsCard keyed off isResign, so this returned true and routed Kara to a
    // pay step demanding $8,538.84 on a card, to re-confirm a date change. resign-settle
    // would have charged nothing (balance_paid_at is NULL → the `resigned_deposit`
    // branch); she simply could not have finished.
    const plan = resignPlan(C31E3AEC);
    expect(plan.isResign).toBe(true);
    expect(plan.settlesNow).toBe(false);
    expect(plan.needsCard).toBe(false);
    // The money is genuinely outstanding — that is the point. It is not collected HERE.
    expect(plan.dueCents).toBe(853884);
    expect(plan.signAction).toBe("confirm");
  });

  it("CONTROL: the shipped gate demanded a card for exactly this contract", () => {
    // The old formula, kept literally so the regression is unmistakable. If someone
    // reverts the fix, this test keeps passing and the one above starts failing —
    // together they say precisely what changed and for whom.
    const plan = resignPlan(C31E3AEC);
    const oldNeedsCard = plan.isResign && plan.dueCents > 0 && !C31E3AEC.hasCardOnFile;
    expect(oldNeedsCard).toBe(true); // what shipped
    expect(plan.needsCard).toBe(false); // what ships now
  });

  it("a deposit-only re-sign with no card is also just a confirmation", () => {
    // Same class as the post-paid case: collected < total by design, 72h cron collects.
    const plan = resignPlan({
      ...C31E3AEC,
      collectedCents: 93570,
      totalCents: 187140,
    });
    expect(plan.needsCard).toBe(false);
    expect(plan.signAction).toBe("confirm");
  });

  it("a paid-in-full re-price still settles inline against the card on file", () => {
    const plan = resignPlan(PAID_IN_FULL);
    expect(plan.settlesNow).toBe(true);
    expect(plan.dueCents).toBe(19963); // total − collected, what resign-settle charges
    expect(plan.needsCard).toBe(false);
    expect(plan.signAction).toBe("pay");
  });

  it("a paid-in-full re-price with NO card on file collects one first", () => {
    // The one case that legitimately needs a card: the server is about to charge and has
    // nothing to charge against.
    const plan = resignPlan({ ...PAID_IN_FULL, hasCardOnFile: false });
    expect(plan.settlesNow).toBe(true);
    expect(plan.needsCard).toBe(true);
    expect(plan.signAction).toBe("continue-to-payment");
  });

  it("a paid-in-full event repriced DOWN confirms without asking for money", () => {
    // Overpaid: resign-settle flags staff to refund, it does not charge.
    const plan = resignPlan({ ...PAID_IN_FULL, totalCents: 150000, hasCardOnFile: false });
    expect(plan.dueCents).toBe(0);
    expect(plan.needsCard).toBe(false);
    expect(plan.signAction).toBe("confirm");
  });

  it("settlesNow tracks the balance_paid_at LATCH, not a derived balance", () => {
    // balance_cents and collected_cents both move under a re-price; balance_paid_at does
    // not, and it is what resign-settle branches on. A fully-collected event whose latch
    // was never set must NOT be treated as settling now.
    const plan = resignPlan({
      ...C31E3AEC,
      collectedCents: 853884, // fully collected…
      balancePaidAt: null, // …but the latch was never set
    });
    expect(plan.settlesNow).toBe(false);
    expect(plan.signAction).toBe("confirm");
  });

  it("is inert for a contract that is not awaiting a re-sign", () => {
    const plan = resignPlan({ ...C31E3AEC, status: "deposit_paid" });
    expect(plan.isResign).toBe(false);
    expect(plan.settlesNow).toBe(false);
    expect(plan.needsCard).toBe(false);
    expect(plan.signAction).toBe("continue-to-payment");
  });

  it("is inert when the deposit was never settled", () => {
    // resign_required without a deposit is not a re-sign — it is a first signature.
    const plan = resignPlan({ ...C31E3AEC, depositPaidAt: null });
    expect(plan.isResign).toBe(false);
    expect(plan.signAction).toBe("continue-to-payment");
  });

  it("never promises a payment step it has not asked for", () => {
    // The invariant behind signAction: "continue-to-payment" appears only when a pay step
    // genuinely follows — i.e. not a re-sign at all, or a re-sign that needs a card.
    const cases: ResignPlanFacts[] = [
      C31E3AEC,
      PAID_IN_FULL,
      { ...PAID_IN_FULL, hasCardOnFile: false },
      { ...C31E3AEC, status: "deposit_paid" },
      { ...C31E3AEC, collectedCents: 853884 },
    ];
    for (const f of cases) {
      const p = resignPlan(f);
      if (p.signAction === "continue-to-payment") {
        expect(!p.isResign || p.needsCard).toBe(true);
      } else {
        expect(p.isResign && !p.needsCard).toBe(true);
      }
    }
  });
});
