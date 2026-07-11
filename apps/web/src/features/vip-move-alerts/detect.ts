/**
 * Pure detection of VIP combo cross-center movements — no I/O.
 *
 * A "move" is an adjacent pair of itinerary steps whose center differs
 * (FastTrax karting <-> HeadPinz bowling) where the earlier step just
 * finished and the later one hasn't started: the party should be walking
 * between centers right now. Race->race within FastTrax never alerts.
 *
 * Reuses the admin board's truth engine (stepProgress over buildComboGroups
 * schedules) so an alert and the board's Done/next markers can never
 * disagree. Takes `nowMs` in the ET-wall frame (format.ts etWallMs) like
 * everything else in the combo engine.
 */
import { stepProgress, type ComboGroup } from "~/features/reservations-admin/combo-board";
import { etWallMs } from "~/features/reservations-admin/format";
import type { ComboScheduleStep } from "~/features/reservations-admin/types";
import { BOWLING_COMBINE_WINDOW_MIN, CLOCK_DONE_GRACE_MIN, STALE_AFTER_MIN } from "./config";

export type MoveDirection = "karting_to_bowling" | "bowling_to_karting";

export interface PendingMove {
  /** ComboGroup.key — the shared deposit order id; the dedup key's identity. */
  groupKey: string;
  direction: MoveDirection;
  guestName: string;
  playerCount?: number;
  comboName: string;
  /** The step that just finished (or is about to — see endingSoon). */
  from: ComboScheduleStep;
  /** The cross-center step up next (may be pending with iso null). */
  to: ComboScheduleStep;
  /** Set when this party hasn't finished yet but their bowling ends within
   *  the combine window of another party's finish, so both ride one card. */
  endingSoon?: { minsLeft: number };
}

function locKind(step: ComboScheduleStep): "karting" | "bowling" {
  return step.loc.startsWith("FastTrax") ? "karting" : "bowling";
}

/** Done by status truth (QAMF lane closed / Pandora session ended), as
 *  opposed to done merely because the scheduled window elapsed. */
function truthDone(s: ComboScheduleStep): boolean {
  return s.legStatus === "completed" || s.raceState === "finished";
}

function endMs(s: ComboScheduleStep): number {
  return s.iso ? etWallMs(s.iso) + s.durationMin * 60_000 : NaN;
}

/** Only bowling steps carry legStatus; a cancelled race leg is covered by
 *  the group-level all-cancelled check (buildComboGroups retires those). */
function dead(s: ComboScheduleStep): boolean {
  return s.legStatus === "cancelled" || s.legStatus === "no_show";
}

/** The later step of a boundary suppresses the alert only on TRUTH (party is
 *  already there / already done) or when its own window has fully passed.
 *  Clock-active without a check-in does NOT suppress — that is exactly the
 *  "guests should be walking over right now" moment — and raceState "called"
 *  means hustle, not already-there. */
function laterStepUnderway(b: ComboScheduleStep, nowMs: number): boolean {
  if (b.legStatus === "arrived" || b.legStatus === "completed") return true;
  if (b.raceState === "on_track" || b.raceState === "finished") return true;
  if (b.iso && nowMs >= endMs(b)) return true; // both windows passed — stale
  return false;
}

/** The cross-center boundary pair starting at a bowling step, if any. */
function bowlingBoundary(
  schedule: ComboScheduleStep[],
): { from: ComboScheduleStep; to: ComboScheduleStep } | null {
  for (let i = 0; i < schedule.length - 1; i++) {
    const a = schedule[i];
    const b = schedule[i + 1];
    if (locKind(a) === "bowling" && locKind(b) === "karting") return { from: a, to: b };
  }
  return null;
}

function toMove(
  g: ComboGroup,
  from: ComboScheduleStep,
  to: ComboScheduleStep,
  endingSoon?: { minsLeft: number },
): PendingMove {
  return {
    groupKey: g.key,
    direction: locKind(from) === "karting" ? "karting_to_bowling" : "bowling_to_karting",
    guestName: g.guestName,
    playerCount: g.playerCount,
    comboName: g.meta?.name ?? "VIP",
    from,
    to,
    endingSoon,
  };
}

export function detectPendingMoves(groups: ComboGroup[], nowMs: number): PendingMove[] {
  const moves: PendingMove[] = [];
  const active = groups.filter(
    (g) => !g.inactive && !g.legs.every((l) => l.status === "cancelled" || l.status === "no_show"),
  );

  for (const g of active) {
    const steps = g.schedule; // already chronological (pending steps last)
    for (let i = 0; i < steps.length - 1; i++) {
      const a = steps[i];
      const b = steps[i + 1];
      if (locKind(a) === locKind(b)) continue; // same center — never alert
      if (dead(a) || dead(b)) continue;
      if (!a.iso) continue; // pending earlier step — nothing finished yet

      const pa = stepProgress(a, nowMs);
      if (!pa || pa.state !== "done") continue;
      const aEnd = endMs(a);
      // Clock-only done: wait out QAMF/Pandora reporting lag before trusting it.
      if (!truthDone(a) && nowMs < aEnd + CLOCK_DONE_GRACE_MIN * 60_000) continue;
      // Data caught up long after the fact — an alert now would just confuse.
      if (nowMs > aEnd + STALE_AFTER_MIN * 60_000) continue;
      if (laterStepUnderway(b, nowMs)) continue;

      moves.push(toMove(g, a, b));
    }
  }

  // Combine window: a party finishing bowling pulls in other parties whose
  // bowling ends within BOWLING_COMBINE_WINDOW_MIN — one card, and their
  // dedup keys get claimed together so no second ping lands minutes later.
  if (moves.some((m) => m.direction === "bowling_to_karting")) {
    const alerted = new Set(
      moves.filter((m) => m.direction === "bowling_to_karting").map((m) => m.groupKey),
    );
    for (const g of active) {
      if (alerted.has(g.key)) continue;
      const boundary = bowlingBoundary(g.schedule);
      if (!boundary) continue;
      const { from, to } = boundary;
      if (dead(from) || dead(to) || !from.iso || truthDone(from)) continue;
      const msLeft = endMs(from) - nowMs;
      if (!(msLeft > 0 && msLeft <= BOWLING_COMBINE_WINDOW_MIN * 60_000)) continue;
      if (laterStepUnderway(to, nowMs)) continue;
      moves.push(toMove(g, from, to, { minsLeft: Math.max(1, Math.ceil(msLeft / 60_000)) }));
    }
  }

  return moves;
}
