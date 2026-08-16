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

/**
 * ONE SCREEN, BOTH TRACKS (owner 2026-08-15: "the secondary check in screen was
 * supposed to be ONE screen not separate for blue and red").
 *
 * That is also what "just need one for blue and one for red when it comes to
 * qualifications" meant — TWO QUALIFYING CARDS in one rotation, not two
 * screens. The lap times are the only content that differs by track, so they
 * are the only thing that gets duplicated.
 */
export type GuideCard =
  | { kind: "shoes" }
  | { kind: "lockers" }
  | { kind: "qualify"; track: TrackKey }
  | { kind: "night" };

/** Stable React key / test handle for a card. */
export function guideCardKey(card: GuideCard): string {
  return card.kind === "qualify" ? `qualify:${card.track}` : card.kind;
}

/**
 * The rotation for a screen covering `tracks`.
 *
 * The shoe rule leads because it is the only one that can send somebody back
 * to their car. The qualifying cards are INTERLEAVED rather than run back to
 * back — two near-identical tables in a row read as a glitch, and splitting
 * them means a guest glancing up twice a minute is more likely to catch their
 * own track's numbers.
 */
export function guideCardsFor(tracks: readonly TrackKey[]): GuideCard[] {
  const [first, ...rest] = tracks;
  const cards: GuideCard[] = [{ kind: "shoes" }];
  if (first) cards.push({ kind: "qualify", track: first });
  cards.push({ kind: "lockers" });
  for (const t of rest) cards.push({ kind: "qualify", track: t });
  cards.push({ kind: "night" });
  return cards;
}

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
export function guideCardAt(nowMs: number, cards: readonly GuideCard[]): GuideCard {
  const list = cards.length > 0 ? cards : [{ kind: "shoes" } as GuideCard];
  const i = Math.floor(nowMs / GUIDE_CARD_MS) % list.length;
  // A negative or non-finite clock must still name a card — a wall with no
  // content is the one outcome worse than the wrong card.
  return list[Number.isFinite(i) && i >= 0 ? i : 0];
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

/* ── which send owns the wall ─────────────────────────────────────────── */

/** One track's live send, as the wall sees it. */
export interface GuideSend {
  track: TrackKey;
  room: "red" | "blue" | null;
  heatNumber: number | null;
  raceType: string | null;
  briefedAtMs: number | null;
}

/**
 * ONE WALL, AND SOMETIMES TWO GROUPS WALKING AT ONCE.
 *
 * A single screen cannot be blue and red simultaneously, and an arrow board
 * that alternates is an arrow board nobody trusts. So the NEWEST send takes
 * the screen — it is the group still standing at the desk, the one that has
 * not started walking yet — and any other live send is named underneath
 * rather than dropped. The earlier group has already had this wall, their own
 * check-in board's takeover, and a member of staff pointing.
 *
 * Returns `primary: null` when nothing is live, which is the ordinary case and
 * means "run the cards".
 */
export function pickTakeover(
  sends: readonly GuideSend[],
  nowMs: number,
  holdMs?: number,
): { primary: GuideSend | null; also: GuideSend[] } {
  const live = sends
    .filter((s) => takeoverState({ briefedAtMs: s.briefedAtMs, nowMs, holdMs }).on)
    // Newest first. A null stamp cannot be live, so the assertion is safe.
    .sort((a, b) => (b.briefedAtMs as number) - (a.briefedAtMs as number));
  return { primary: live[0] ?? null, also: live.slice(1) };
}

/**
 * ONE SESSION, ONE ROW — the Mega dedupe.
 *
 * On a Mega day the feed asks its configured tracks ("blue", "red") for their
 * sessions and BOTH resolve to the one combined heat, so the wall would show
 * the same group twice: once as the takeover and again as a chip underneath
 * (pickTakeover cannot tell them apart — same stamps, different track labels).
 *
 * When one sessionId appears under two DISTINCT tracks, keep the first row in
 * input order, relabeled `mega` — the only mechanism that puts one session
 * under both tracks is the Mega fallback, so the relabel is truthful, and it
 * buys the takeover the Mega accent and wording instead of arbitrarily
 * claiming blue. Rows with a null sessionId pass through untouched (duplication
 * cannot be proven), and on a normal day every track has its own session, so
 * this is the identity function.
 */
export function dedupeGuideRows<T extends { track: TrackKey; sessionId: number | string | null }>(
  rows: readonly T[],
): T[] {
  const out: T[] = [];
  const firstBySession = new Map<string, { index: number; track: TrackKey }>();
  for (const row of rows) {
    if (row.sessionId == null) {
      out.push(row);
      continue;
    }
    const key = String(row.sessionId);
    const seen = firstBySession.get(key);
    if (!seen) {
      firstBySession.set(key, { index: out.length, track: row.track });
      out.push(row);
      continue;
    }
    if (seen.track !== row.track) {
      out[seen.index] = { ...out[seen.index], track: "mega" as TrackKey };
    }
  }
  return out;
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
