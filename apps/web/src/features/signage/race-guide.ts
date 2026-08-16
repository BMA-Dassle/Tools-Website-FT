/**
 * The check-in guide wall — every decision it makes, as pure functions.
 *
 * WHAT THIS SCREEN IS. A wall between the check-in desk and the briefing
 * rooms. It explains racing over track photography while people wait, and the
 * moment their heat is sent to a room it floods with that track's colour and
 * points at the door.
 *
 * THE TAKEOVER IS THE POINT; the cards are what it does the rest of the time.
 * The trigger is the SAME `briefedAtMs` the check-in board reacts to, so the
 * two screens flip together rather than a poll apart — and this one holds
 * longer, because the desk is finished with a group once they turn around and
 * this wall is not finished until they are through the door.
 *
 * PURE — no I/O, no clock of its own. Everything derives from `nowMs`, which
 * is the shared corrected clock, so two screens cannot disagree about which
 * card is up.
 */
import { nextLevelTarget, type QualifyTargetLevel } from "~/features/racing/qualify";
import { TRACK_LABELS, type TrackKey } from "./track";

/** The four things this wall says. Order is the rotation order, and it is not
 *  arbitrary: the shoe rule can send somebody back to their car, so it leads. */
export const GUIDE_CARDS = ["shoes", "lockers", "qualify", "night"] as const;
export type GuideCard = (typeof GUIDE_CARDS)[number];

/** How long each card holds. Long enough to read a headline and a line of body
 *  from across a corridor without hurrying, short enough that somebody waiting
 *  out a check-in sees all four. */
export const GUIDE_CARD_MS = 12_000;

/** How long the wayfinding takeover holds after a send, unless a screen says
 *  otherwise. The check-in board holds its own version 60s; this one is read by
 *  people already walking, and a group that dawdles must not arrive to find the
 *  sign gone. */
export const GUIDE_TAKEOVER_MS = 120_000;

/** Bounds on a configured hold, so a hand-edited config cannot pin the wall on
 *  one instruction all night or blink it out before anyone turns around. */
export const GUIDE_HOLD_MIN_MS = 20_000;
export const GUIDE_HOLD_MAX_MS = 10 * 60_000;

export function clampHoldMs(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return GUIDE_TAKEOVER_MS;
  return Math.min(GUIDE_HOLD_MAX_MS, Math.max(GUIDE_HOLD_MIN_MS, value));
}

/**
 * Which card is showing.
 *
 * Derived from the shared clock rather than a mounted timer, which is what
 * keeps two guide walls in step and what lets a screen that reboots rejoin
 * mid-rotation instead of restarting the loop.
 */
export function guideCardAt(nowMs: number): GuideCard {
  const i = Math.floor(nowMs / GUIDE_CARD_MS) % GUIDE_CARDS.length;
  // A negative or non-finite clock must still name a card — a wall with no
  // content is the one outcome worse than the wrong card.
  return GUIDE_CARDS[Number.isFinite(i) && i >= 0 ? i : 0];
}

/**
 * Is the wayfinding takeover up, and for how much longer?
 *
 * The small negative tolerance mirrors the check-in board's: the send stamp is
 * a server clock and the screen's is the shared corrected one, so a stamp a
 * beat "in the future" is an ordinary skew, not a reason to ignore an
 * instruction somebody is walking towards.
 */
const CLOCK_SKEW_TOLERANCE_MS = 5_000;

export function takeoverState(args: {
  briefedAtMs: number | null;
  nowMs: number;
  holdMs?: number;
}): { on: boolean; remainingMs: number } {
  const hold = clampHoldMs(args.holdMs);
  if (args.briefedAtMs === null || !Number.isFinite(args.briefedAtMs)) {
    return { on: false, remainingMs: 0 };
  }
  const ago = args.nowMs - args.briefedAtMs;
  if (ago < -CLOCK_SKEW_TOLERANCE_MS || ago >= hold) return { on: false, remainingMs: 0 };
  return { on: true, remainingMs: Math.max(0, hold - ago) };
}

/* ── the qualifying card ──────────────────────────────────────────────── */

export interface QualifyRow {
  from: string;
  to: QualifyTargetLevel;
  ms: number;
}

export interface QualifyBoard {
  /** The two steps of the ADULT ladder on THIS track — the whole point of the
   *  card, and the only part whose numbers change between Blue and Red. */
  adult: QualifyRow[];
  /** The junior ladder. One pair of numbers venue-wide rather than per track,
   *  so it rides as a footnote instead of pretending to be track-specific. */
  junior: QualifyRow[];
  /** "Blue Track" — the card says which track these times belong to, because
   *  heat numbers and lap times are BOTH per-track here. */
  trackLabel: string;
}

/**
 * The ladder for one track.
 *
 * EVERY NUMBER COMES FROM `nextLevelTarget`, the same function the level-up
 * text message and the results wall read. Nothing here restates a cutoff: a
 * wall that advertises a time the system will not honour is worse than a wall
 * with no times on it, and that is exactly what a second copy of these numbers
 * would eventually produce.
 */
export function qualifyBoardFor(track: TrackKey): QualifyBoard {
  const rows = (pairs: Array<[string, string]>): QualifyRow[] => {
    const out: QualifyRow[] = [];
    for (const [label, raceType] of pairs) {
      const target = nextLevelTarget(track, raceType);
      if (!target) continue;
      out.push({ from: label, to: target.level, ms: target.ms });
    }
    return out;
  };

  return {
    adult: rows([
      ["Starter", "Starter"],
      ["Intermediate", "Intermediate"],
    ]),
    junior: rows([
      ["Junior Starter", "Junior Starter"],
      ["Junior Intermediate", "Junior Intermediate"],
    ]),
    trackLabel: TRACK_LABELS[track],
  };
}
