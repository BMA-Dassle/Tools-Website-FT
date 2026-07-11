import { describe, expect, it } from "vitest";

import { EditGuardError } from "./types";
import { assertEditable, selectPhase, type EditabilityFacts, type PhaseFacts } from "./guards";

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
