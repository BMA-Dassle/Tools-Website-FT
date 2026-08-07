import { afterEach, describe, expect, it } from "vitest";

import { EditGuardError } from "./types";
import {
  assertEditable,
  editFlagEnabled,
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
