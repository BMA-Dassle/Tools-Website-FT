/**
 * Reservation-edit guards — phase selection + editability. PURE: callers load
 * the Neon row and the LIVE Square order facts; these functions only decide.
 *
 * Phase truth table (per day-of order, from LIVE Square facts — never Neon
 * alone; the lane-open cron can beat a stale read):
 *   pre           — not lane-opened: dayof_order_sent_at IS NULL AND the
 *                   order (when one exists) is DRAFT/OPEN with 0 tenders.
 *   mid           — lane opened: order OPEN with ≥1 tender (the gift card
 *                   paid it) and sent_at set.
 *   post_complete — order COMPLETED (or the row already says completed).
 * Anything else is a phase_conflict → manual handling, never money movement.
 */

import { EditGuardError, type EditPhase, type EditStepKind } from "./types";

export type SquareOrderState = "DRAFT" | "OPEN" | "COMPLETED" | "CANCELED";

/** The minimal facts phase selection needs. */
export interface PhaseFacts {
  status:
    | "confirmed"
    | "confirm_pending"
    | "confirm_failed"
    | "arrived"
    | "completed"
    | "no_show"
    | "cancelled";
  /** bowling_reservations.dayof_order_sent_at (null = lane not opened). */
  dayofOrderSentAt: string | null;
  /** Whether the row has a day-of order at all ($0 bookings may not). */
  hasDayofOrder: boolean;
  /** LIVE Square order state (null when hasDayofOrder is false or fetch n/a). */
  orderState: SquareOrderState | null;
  /** LIVE tender count on the day-of order (0 when no order). */
  orderTenderCount: number;
}

/**
 * Derive the money phase. Throws EditGuardError on terminal/ambiguous rows:
 *   cancelled       — row is cancelled (edit is meaningless; use rebook).
 *   phase_conflict  — Neon and Square disagree (e.g. sent_at set but the
 *                     order shows no tenders, or tenders exist while sent_at
 *                     is NULL, or the order was CANCELED outside a cancel).
 */
export const selectPhase = (facts: PhaseFacts): EditPhase => {
  if (facts.status === "cancelled") throw new EditGuardError("cancelled");

  // Completed rows / completed orders → post_complete regardless of the rest.
  if (facts.status === "completed" || facts.orderState === "COMPLETED") {
    return "post_complete";
  }

  if (facts.orderState === "CANCELED") {
    throw new EditGuardError(
      "phase_conflict",
      "day-of order is CANCELED but the reservation is not cancelled",
    );
  }

  const sent = facts.dayofOrderSentAt != null;
  const tendered = facts.orderTenderCount > 0;

  if (!facts.hasDayofOrder) {
    // $0 bookings (free KBF) — no order, no money. Phase still splits on
    // lane-open so external-sync rules apply correctly.
    return sent ? "mid" : "pre";
  }

  if (sent && tendered) return "mid";
  if (!sent && !tendered) return "pre";

  // sent_at set but no payment landed (lane-open error path), or Square shows
  // money Neon doesn't know about — both are manual territory.
  throw new EditGuardError(
    "phase_conflict",
    sent
      ? "lane-open marked sent but the day-of order has no tenders"
      : "day-of order has tenders but lane-open never marked the row",
  );
};

/**
 * Is this rollout flag ON? Reservation-edit flags are KILL SWITCHES, not opt-in
 * gates (CLAUDE.md hard rule): the feature is merged, so it is ON, and the env
 * var exists only so ops can turn it OFF without a deploy. Hence `!== "false"`
 * — unset means enabled.
 *
 * Single source of polarity for the whole feature. The route, the planner's
 * `executionBlocked` preview, and the executor all read through here, so the
 * preview can never disagree with the gate that actually runs. Read at call
 * time (never module scope) so flipping a var in Vercel takes effect on the
 * next request instead of the next build.
 */
export const editFlagEnabled = (name: string): boolean => process.env[name] !== "false";

/**
 * Env flag that must be on for money to come BACK off an already-paid day-of
 * order in this phase, or null when the phase needs no such flag (pre-payment
 * decreases settle against the deposit and ride the master switch).
 *
 * Single source of truth, deliberately keyed on the PHASE rather than on step
 * kinds: refund_dayof_payment is emitted by both mid and post_complete, so
 * kind-keyed gating maps the wrong flag onto each phase. The planner uses this
 * to disable Execute with a reason before staff fill the form out; the executor
 * re-checks it as the real gate (never trust a client-supplied plan).
 */
export const refundFlagForPhase = (phase: EditPhase): string | null =>
  phase === "mid"
    ? "RESERVATION_EDIT_V2_MID_DECREASE"
    : phase === "post_complete"
      ? "RESERVATION_EDIT_V2_POST"
      : null;

/**
 * Steps a REFUND-ONLY plan is allowed to contain. Deliberately an ALLOWLIST:
 * anything not named here — a charge, an external sync, an order rebuild, a new
 * step kind added later — makes the plan not-refund-only and therefore subject
 * to the master switch. Denied by default is the only safe posture for a rule
 * that decides whether money may move without the master flag.
 */
const REFUND_ONLY_STEPS: ReadonlySet<EditStepKind> = new Set<EditStepKind>([
  "audit_start",
  "refund_dayof_payment",
  "refund_tender",
  "issue_store_credit",
  "adjust_gift_card_down",
  "reconcile_gift_card",
  "neon_commit",
  "notify",
]);

/**
 * True when this plan does nothing but hand money back for an already-paid
 * day-of order — the shape the Refund action produces.
 *
 * Such a plan may execute on its PHASE flag alone (refundFlagForPhase) rather
 * than requiring RESERVATION_EDIT_V2. Both default ON, so the exemption is no
 * longer what makes refunds reachable — it is what keeps them reachable if ops
 * ever throws the master kill switch. Editing and refunding fail for unrelated
 * reasons (the master covers QAMF/BMI sync and charges); killing the former
 * must never strand a guest's money. Note `refund_dayof_order` is NOT in the
 * allowlist: it only appears in
 * the post-complete REBUILD path, which charges and rebuilds and therefore
 * always needs the master flag.
 */
export const isRefundOnlyPlan = (plan: {
  diffCents: number;
  steps: ReadonlyArray<{ kind: EditStepKind }>;
}): boolean =>
  // Money strictly comes back...
  plan.diffCents < 0 &&
  // ...off a PAID day-of order (a pre-payment decrease is an ordinary edit)...
  plan.steps.some((s) => s.kind === "refund_dayof_payment") &&
  // ...and nothing else happens.
  plan.steps.every((s) => REFUND_ONLY_STEPS.has(s.kind));

/**
 * Kill switch for the PRE-phase DECREASE path — a reduction taken BEFORE the
 * lane opens, while the day-of order is still OPEN with zero tenders and the
 * internal gift card has not paid it yet.
 *
 * Its own switch (not the master) because this shape is money-symmetric with a
 * refund: value goes back to the guest, the untendered order's lines are
 * corrected to match, and nothing charges. Ops needs to be able to stop it
 * without also stopping increases, lane moves, or race edits — and, in the
 * other direction, to stop it even while the master is on.
 */
export const PRE_DECREASE_FLAG = "RESERVATION_EDIT_V2_PRE_DECREASE";

/**
 * FATAL steps a PRE-phase decrease may contain. Allowlist, denied by default.
 *
 * `update_dayof_order` is the one step here that no refund plan may carry, and
 * it is safe in `pre` for the reason it is forbidden later: Square only refuses
 * line edits on an order with FINALIZED TENDERS ("LineItems cannot be modified
 * for finalized tenders"). A `pre` order has none by definition of selectPhase,
 * so its lines are still writable — which is why the pre branch corrects them
 * instead of attaching a return order.
 */
const PRE_DECREASE_FATAL_STEPS: ReadonlySet<EditStepKind> = new Set<EditStepKind>([
  "audit_start",
  "refund_tender",
  "issue_store_credit",
  "adjust_gift_card_down",
  "update_dayof_order",
  "neon_commit",
]);

/**
 * NON-FATAL steps that may ride along. These cannot move money and cannot fail
 * the cascade; they only push the new headcount at Conqueror, where the desk
 * sets it at check-in anyway. Kept as a SEPARATE allowlist so a step's
 * permission is tied to its blast radius, not merely to its name.
 *
 * `bmi_remove_lines` is deliberately EXCLUDED even though the pre branch emits
 * it non-fatally: BMI heats are capacity and entitlement, not an advisory
 * roster, so a race-heat change stays under the master switch.
 */
const PRE_DECREASE_ADVISORY_STEPS: ReadonlySet<EditStepKind> = new Set<EditStepKind>([
  "notify",
  "qamf_set_players",
  "qamf_memo",
]);

/**
 * True when this plan is nothing but a pre-payment REDUCTION: money back to the
 * guest (card or store credit), the deposit gift card decremented to match, the
 * still-untendered day-of order's lines corrected, and at most an advisory
 * Conqueror roster push.
 *
 * Deliberately a second predicate rather than a widening of isRefundOnlyPlan.
 * That one is load-bearing for 51 production refunds and its own test asserts
 * this exact shape is NOT refund-only ("requires the money to come off a PAID
 * day-of order"), which stays true. Two narrow gates beat one loose gate.
 *
 * Evaluated per step by BLAST RADIUS: a step is advisory only when it is
 * explicitly `fatal: false`. An absent `fatal` is treated as fatal, so a step
 * shape we have not seen can never sneak in through the softer list.
 */
export const isPreDecreaseOnlyPlan = (plan: {
  phase: EditPhase;
  diffCents: number;
  steps: ReadonlyArray<{ kind: EditStepKind; fatal?: boolean }>;
}): boolean =>
  // Only before lane-open — after that the tender exists and lines freeze.
  plan.phase === "pre" &&
  // Money strictly comes back. An increase charges, and charging is the
  // master switch's business.
  plan.diffCents < 0 &&
  // ...and every step is permitted for what it can actually break.
  plan.steps.every((s) =>
    s.fatal === false
      ? PRE_DECREASE_ADVISORY_STEPS.has(s.kind)
      : PRE_DECREASE_FATAL_STEPS.has(s.kind),
  );

/** Reservation kinds the engine edits. */
export type EditableKind = "kbf" | "open" | "race" | "attraction";

export interface EditabilityFacts {
  productKind: EditableKind;
  phase: EditPhase;
  /** True when the edit changes the lane count (bowling per-lane flows). */
  changesLaneCount: boolean;
  /** True when the edit touches race heats (add or remove). */
  changesRaceHeats: boolean;
  /** Combo money group: per-leg phases (single-leg rows pass [phase]). */
  legPhases: EditPhase[];
  isCombo: boolean;
  /** Manager acknowledged the post-complete "QAMF/BMI not updated" warning. */
  managerOverride: boolean;
}

/**
 * Cross-cutting editability rules (phase × change-shape). Throws typed guard
 * errors; returns void when the edit may proceed to planning.
 */
export const assertEditable = (f: EditabilityFacts): void => {
  // Every leg of a money group must sit in the SAME phase. A mixed-phase
  // group settles money against instruments in different states, and
  // buildEditPlan collapses the group to phases[0] — so the plan silently
  // describes one leg's world while the money touches a shared instrument.
  //
  // The concrete hazard is the shared internal gift card: an item refund on a
  // CHARGED leg decrements it while an un-charged sibling still needs its
  // share to pay its own day-of order. If the sibling's charge cron fires
  // into that hole, the payment fails — and a failed payment still BURNS its
  // deterministic idempotency key (lane-open / race-dayof-pay / no-show-close
  // all key off the reservation id), leaving that leg permanently
  // unchargeable. Refuse instead.
  if (f.legPhases.length > 1 && new Set(f.legPhases).size > 1) {
    throw new EditGuardError(
      f.isCombo ? "combo_phase_split" : "leg_phase_split",
      f.isCombo
        ? undefined
        : "this booking's legs are in different states (one is already charged, another is not) — " +
            "edit them from the leg that is still un-charged, or handle it manually in Square",
    );
  }
  // v1: combo edits only while every leg is un-tendered.
  if (f.isCombo && f.phase !== "pre") {
    throw new EditGuardError(
      "combo_phase_split",
      "combo edits are only supported before lane-open / race settle",
    );
  }

  if (f.phase === "mid") {
    // Guest is on the lanes: growing/shrinking the lane block mid-session is
    // a physical operation Conqueror owns — refuse.
    if (f.changesLaneCount) throw new EditGuardError("lane_change_mid_session");
    // BMI race session is live mid-phase — heats can't be honestly edited.
    if (f.changesRaceHeats) {
      throw new EditGuardError("mid_session_unsupported", "race heats cannot change mid-session");
    }
  }

  if (f.phase === "post_complete" && !f.managerOverride) {
    throw new EditGuardError("post_complete_ack_required");
  }
};
