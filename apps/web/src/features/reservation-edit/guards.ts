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

import { EditGuardError, type EditPhase } from "./types";

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
  // Combo legs must sit in the SAME phase — mixed-phase combos (race leg
  // settled, bowling leg pre-open) settle money against instruments in
  // different states and are v1-refused.
  if (f.isCombo && new Set(f.legPhases).size > 1) {
    throw new EditGuardError("combo_phase_split");
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
