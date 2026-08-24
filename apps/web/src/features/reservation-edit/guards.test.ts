import { afterEach, describe, expect, it } from "vitest";

import { EditGuardError } from "./types";
import {
  assertEditable,
  editFlagEnabled,
  isPreDecreaseOnlyPlan,
  isRefundOnlyPlan,
  refundFlagForPhase,
  selectPhase,
  type EditabilityFacts,
  type PhaseFacts,
} from "./guards";
import type { EditStepKind } from "./types";

const base: PhaseFacts = {
  status: "confirmed",
  dayofOrderSentAt: null,
  hasDayofOrder: true,
  orderState: "OPEN",
  orderTenderCount: 0,
};

const code = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    if (e instanceof EditGuardError) return e.code;
    throw e;
  }
  throw new Error("expected EditGuardError");
};

describe("selectPhase", () => {
  it("pre: not sent, order OPEN, no tenders", () => {
    expect(selectPhase(base)).toBe("pre");
  });

  it("mid: sent + order OPEN with tenders (gift card redeemed)", () => {
    expect(
      selectPhase({ ...base, dayofOrderSentAt: "2026-07-11T10:00:00Z", orderTenderCount: 1 }),
    ).toBe("mid");
  });

  it("post_complete: live order COMPLETED wins regardless of Neon", () => {
    expect(selectPhase({ ...base, orderState: "COMPLETED" })).toBe("post_complete");
    expect(
      selectPhase({
        ...base,
        status: "arrived",
        dayofOrderSentAt: "x",
        orderState: "COMPLETED",
        orderTenderCount: 1,
      }),
    ).toBe("post_complete");
  });

  it("post_complete: row status completed even if order fetch says OPEN", () => {
    expect(selectPhase({ ...base, status: "completed" })).toBe("post_complete");
  });

  it("cancelled rows are refused", () => {
    expect(code(() => selectPhase({ ...base, status: "cancelled" }))).toBe("cancelled");
  });

  it("CANCELED order without a cancelled row is a phase_conflict", () => {
    expect(code(() => selectPhase({ ...base, orderState: "CANCELED" }))).toBe("phase_conflict");
  });

  it("sent_at set but no tenders (failed lane-open) is a phase_conflict", () => {
    expect(code(() => selectPhase({ ...base, dayofOrderSentAt: "2026-07-11T10:00:00Z" }))).toBe(
      "phase_conflict",
    );
  });

  it("tenders without sent_at (Square ahead of Neon) is a phase_conflict", () => {
    expect(code(() => selectPhase({ ...base, orderTenderCount: 1 }))).toBe("phase_conflict");
  });

  it("$0 rows without an order split phases on sent_at alone", () => {
    const free = { ...base, hasDayofOrder: false, orderState: null };
    expect(selectPhase(free)).toBe("pre");
    expect(selectPhase({ ...free, dayofOrderSentAt: "2026-07-11T10:00:00Z" })).toBe("mid");
  });

  it("arrived-but-unpaid rows still read as pre (arrival ≠ lane-open)", () => {
    expect(selectPhase({ ...base, status: "arrived" })).toBe("pre");
  });
});

describe("editFlagEnabled", () => {
  const NAME = "RESERVATION_EDIT_V2_TEST_ONLY";
  afterEach(() => {
    delete process.env[NAME];
  });

  it("is ON when the var is unset — kill switch, not an opt-in gate", () => {
    // The rule this closes (CLAUDE.md): a merged feature is ON. An `=== "true"`
    // gate ships the feature dark and makes every environment that forgot the
    // var silently broken, which is exactly how this engine sat unusable.
    expect(editFlagEnabled(NAME)).toBe(true);
  });

  it('is OFF only for the exact string "false"', () => {
    process.env[NAME] = "false";
    expect(editFlagEnabled(NAME)).toBe(false);
  });

  it('stays ON for every other value, including "true" and junk', () => {
    for (const v of ["true", "1", "0", "", "FALSE", "no", "off"]) {
      process.env[NAME] = v;
      expect(editFlagEnabled(NAME)).toBe(true);
    }
  });

  it("reads at CALL time so a flip needs no redeploy", () => {
    expect(editFlagEnabled(NAME)).toBe(true);
    process.env[NAME] = "false";
    expect(editFlagEnabled(NAME)).toBe(false);
    delete process.env[NAME];
    expect(editFlagEnabled(NAME)).toBe(true);
  });
});

describe("refundFlagForPhase", () => {
  it("maps each post-payment phase to ITS OWN flag", () => {
    // The bug this closes: gating on step kind instead of phase. Both phases
    // emit refund_dayof_payment, so kind-keyed gating let _MID_DECREASE govern
    // post-complete refunds while _POST governed nothing that ships.
    expect(refundFlagForPhase("mid")).toBe("RESERVATION_EDIT_V2_MID_DECREASE");
    expect(refundFlagForPhase("post_complete")).toBe("RESERVATION_EDIT_V2_POST");
  });

  it("returns null for pre — nothing is paid yet, so no refund flag applies", () => {
    expect(refundFlagForPhase("pre")).toBeNull();
  });

  it("never maps two phases to the same flag", () => {
    const flags = (["mid", "post_complete"] as const).map(refundFlagForPhase);
    expect(new Set(flags).size).toBe(flags.length);
  });
});

describe("isRefundOnlyPlan", () => {
  const plan = (diffCents: number, ...kinds: EditStepKind[]) => ({
    diffCents,
    steps: kinds.map((kind) => ({ kind })),
  });
  /** The shape the Refund action actually produces (proved live, 19/19). */
  const REFUND: EditStepKind[] = [
    "audit_start",
    "refund_dayof_payment",
    "refund_tender",
    "reconcile_gift_card",
    "neon_commit",
    "notify",
  ];

  it("accepts the money-only refund cascade", () => {
    expect(isRefundOnlyPlan(plan(-2767, ...REFUND))).toBe(true);
  });

  it("accepts a refund settled to a gift card instead of the card", () => {
    expect(
      isRefundOnlyPlan(
        plan(-642, "audit_start", "refund_dayof_payment", "issue_store_credit", "neon_commit"),
      ),
    ).toBe(true);
  });

  it("requires money to actually come back", () => {
    // A zero or positive diff is not a refund no matter what steps it carries.
    expect(isRefundOnlyPlan(plan(0, ...REFUND))).toBe(false);
    expect(isRefundOnlyPlan(plan(1500, ...REFUND))).toBe(false);
  });

  it("requires the money to come off a PAID day-of order", () => {
    // A pre-payment decrease refunds the deposit directly — an ordinary edit
    // that belongs to the master switch, not the refund exemption.
    expect(
      isRefundOnlyPlan(
        plan(-500, "audit_start", "refund_tender", "adjust_gift_card_down", "neon_commit"),
      ),
    ).toBe(false);
  });

  it("rejects anything that also charges, syncs, or rebuilds", () => {
    // Each of these would sneak a non-refund capability past the master switch.
    for (const extra of [
      "charge_topup",
      "charge_dayof_order",
      "load_gift_card",
      "qamf_set_players",
      "qamf_rebook",
      "bmi_remove_lines",
      "bmi_add_heats",
      "update_dayof_order",
      "refund_dayof_order",
      "rebuild_dayof_order",
      "pay_dayof_order",
      "complete_dayof_order",
      "await_payment_link",
    ] as EditStepKind[]) {
      expect(isRefundOnlyPlan(plan(-2767, ...REFUND, extra))).toBe(false);
    }
  });

  it("is an ALLOWLIST — an unknown future step kind is refused, not permitted", () => {
    // The whole point: adding a step to the engine must never silently widen
    // what may run without the master flag.
    expect(
      isRefundOnlyPlan(plan(-2767, ...REFUND, "some_new_step_nobody_reviewed" as EditStepKind)),
    ).toBe(false);
  });
});

describe("isPreDecreaseOnlyPlan", () => {
  type S = { kind: EditStepKind; fatal?: boolean };
  const f = (kind: EditStepKind): S => ({ kind, fatal: true });
  const nf = (kind: EditStepKind): S => ({ kind, fatal: false });
  const pre = (diffCents: number, ...steps: S[]) => ({
    phase: "pre" as const,
    diffCents,
    steps,
  });

  /** Exactly what plan.ts emits for a pre-payment headcount reduction. */
  const SHRINK: S[] = [
    f("audit_start"),
    f("refund_tender"),
    f("adjust_gift_card_down"),
    f("update_dayof_order"),
    f("neon_commit"),
    nf("qamf_set_players"),
    nf("qamf_memo"),
    nf("notify"),
  ];

  it("accepts the pre-payment reduction the pre branch actually builds", () => {
    expect(isPreDecreaseOnlyPlan(pre(-1703, ...SHRINK))).toBe(true);
  });

  it("accepts a reduction settled to store credit instead of the card", () => {
    expect(
      isPreDecreaseOnlyPlan(
        pre(
          -1703,
          f("audit_start"),
          f("issue_store_credit"),
          f("adjust_gift_card_down"),
          f("update_dayof_order"),
          f("neon_commit"),
        ),
      ),
    ).toBe(true);
  });

  it("accepts a reduction with no day-of order yet (nothing to correct)", () => {
    expect(
      isPreDecreaseOnlyPlan(
        pre(
          -500,
          f("audit_start"),
          f("refund_tender"),
          f("adjust_gift_card_down"),
          f("neon_commit"),
        ),
      ),
    ).toBe(true);
  });

  it("refuses any phase but pre — after lane-open the tender exists", () => {
    // The whole safety argument is that a `pre` order has NO finalized tenders,
    // so update_dayof_order is legal. That stops being true in mid/post.
    for (const phase of ["mid", "post_complete"] as const) {
      expect(isPreDecreaseOnlyPlan({ phase, diffCents: -1703, steps: SHRINK })).toBe(false);
    }
  });

  it("requires money to come back — an increase belongs to the master switch", () => {
    expect(isPreDecreaseOnlyPlan(pre(0, ...SHRINK))).toBe(false);
    expect(isPreDecreaseOnlyPlan(pre(1500, ...SHRINK))).toBe(false);
  });

  it("refuses anything that charges, rebooks, or touches BMI", () => {
    for (const extra of [
      f("charge_topup"),
      f("load_gift_card"),
      f("charge_dayof_order"),
      f("await_payment_link"),
      f("qamf_rebook"),
      f("bmi_add_heats"),
      f("bmi_attractions"),
      f("refund_dayof_payment"),
      f("refund_dayof_order"),
      f("rebuild_dayof_order"),
      f("pay_dayof_order"),
      f("complete_dayof_order"),
    ]) {
      expect(isPreDecreaseOnlyPlan(pre(-1703, ...SHRINK, extra))).toBe(false);
    }
  });

  it("refuses a race-heat removal even though the pre branch emits it non-fatally", () => {
    // BMI heats are capacity + entitlement, not an advisory roster. Being
    // non-fatal does not make them advisory.
    expect(isPreDecreaseOnlyPlan(pre(-1703, ...SHRINK, nf("bmi_remove_lines")))).toBe(false);
  });

  it("gates a step on its BLAST RADIUS, not just its name", () => {
    // qamf_set_players is permitted only while it cannot fail the cascade.
    expect(isPreDecreaseOnlyPlan(pre(-1703, f("audit_start"), nf("qamf_set_players")))).toBe(true);
    expect(isPreDecreaseOnlyPlan(pre(-1703, f("audit_start"), f("qamf_set_players")))).toBe(false);
  });

  it("treats a MISSING fatal flag as fatal — softer list is never the default", () => {
    // An unmarked step must not slip through the advisory allowlist.
    expect(isPreDecreaseOnlyPlan(pre(-1703, f("audit_start"), { kind: "notify" }))).toBe(false);
  });

  it("is an ALLOWLIST — an unknown future step kind is refused on both lists", () => {
    const unknown = "some_new_step_nobody_reviewed" as EditStepKind;
    expect(isPreDecreaseOnlyPlan(pre(-1703, ...SHRINK, f(unknown)))).toBe(false);
    expect(isPreDecreaseOnlyPlan(pre(-1703, ...SHRINK, nf(unknown)))).toBe(false);
  });

  it("does NOT overlap isRefundOnlyPlan — the two gates stay disjoint", () => {
    // A pre reduction must never ride the refund flags, and a paid-order
    // refund must never ride the pre flag.
    expect(isRefundOnlyPlan({ diffCents: -1703, steps: SHRINK })).toBe(false);
    expect(
      isPreDecreaseOnlyPlan(
        pre(
          -2767,
          f("audit_start"),
          f("refund_dayof_payment"),
          f("refund_tender"),
          f("reconcile_gift_card"),
          f("neon_commit"),
        ),
      ),
    ).toBe(false);
  });
});

describe("assertEditable", () => {
  const facts: EditabilityFacts = {
    productKind: "open",
    phase: "pre",
    changesLaneCount: false,
    changesRaceHeats: false,
    legPhases: ["pre"],
    isCombo: false,
    managerOverride: false,
  };

  it("pre-phase ordinary edits pass", () => {
    expect(() => assertEditable(facts)).not.toThrow();
  });

  it("combo legs in different phases are refused", () => {
    expect(code(() => assertEditable({ ...facts, isCombo: true, legPhases: ["pre", "mid"] }))).toBe(
      "combo_phase_split",
    );
  });

  it("NON-combo multi-leg groups in different phases are refused too", () => {
    // A shared internal gift card + an un-charged sibling leg: decrementing
    // for a refund on the charged leg can starve the sibling's own day-of
    // charge, and a failed charge burns its deterministic idempotency key —
    // leaving that leg permanently unchargeable.
    expect(
      code(() => assertEditable({ ...facts, isCombo: false, legPhases: ["mid", "pre"] })),
    ).toBe("leg_phase_split");
  });

  it("multi-leg groups all in the SAME phase still pass", () => {
    expect(() =>
      assertEditable({ ...facts, isCombo: false, legPhases: ["pre", "pre"] }),
    ).not.toThrow();
  });

  it("combo edits after lane-open are refused (v1)", () => {
    expect(
      code(() => assertEditable({ ...facts, isCombo: true, phase: "mid", legPhases: ["mid"] })),
    ).toBe("combo_phase_split");
  });

  it("lane-count changes mid-session are refused", () => {
    expect(code(() => assertEditable({ ...facts, phase: "mid", changesLaneCount: true }))).toBe(
      "lane_change_mid_session",
    );
  });

  it("race-heat changes mid-session are refused", () => {
    expect(code(() => assertEditable({ ...facts, phase: "mid", changesRaceHeats: true }))).toBe(
      "mid_session_unsupported",
    );
  });

  it("player edits mid-session (no lanes/heats) pass", () => {
    expect(() => assertEditable({ ...facts, phase: "mid" })).not.toThrow();
  });

  it("post-complete requires the manager acknowledgment", () => {
    expect(code(() => assertEditable({ ...facts, phase: "post_complete" }))).toBe(
      "post_complete_ack_required",
    );
    expect(() =>
      assertEditable({ ...facts, phase: "post_complete", managerOverride: true }),
    ).not.toThrow();
  });
});
