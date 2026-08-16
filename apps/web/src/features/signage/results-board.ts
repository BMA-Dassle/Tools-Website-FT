/**
 * The race results board — every decision it makes, as pure functions.
 *
 * WHAT THIS SCREEN IS. A wall at the kart return showing the race that just
 * came back in: final standings, best laps, and who levelled up. It is the
 * SCORES surface the briefing room's welcome-back board points people to,
 * which is why it carries lap times and that board deliberately does not
 * (owner 2026-08-11, "no lap times on this screen" — that instruction is
 * about the briefing room, not about the venue).
 *
 * "QUALIFIED" MEANS LEVELLED UP, and nothing else. There is no finals bracket
 * and no top-N-advance anywhere in this system — a racer qualifies by beating
 * a lap-time cutoff and moves Starter → Intermediate → Pro. The cutoffs come
 * from `racing/qualify`, the ONE module the level-up text message also reads,
 * so the wall and the text can never disagree in front of the racer.
 *
 * PURE — no I/O, no clock, no Redis. The resolver that feeds it lives in
 * service/results-board.server.ts; everything worth asserting on is here.
 */
import { nextLevelTarget, type QualifyTargetLevel } from "~/features/racing/qualify";
import { TRACK_LABELS, type TrackKey } from "./track";

/** Above this many racers the board splits into two columns and the
 *  qualifying panel becomes a band along the bottom. A Mega grid runs the
 *  combined circuit and can be roughly twice a split-track grid. */
export const WIDE_GRID_FROM = 13;

/** One row of the standings. */
export interface ResultsBoardDriver {
  /** Verbatim from the timing system — no BMI person matching (owner). */
  name: string;
  /** Best lap in ms; null when the racer never set a clean lap. */
  bestMs: number | null;
  kart: string;
  laps: number;
  position: number;
  /** Beat the qualifying time for the next level in this race type. */
  qualified: boolean;
}

/** Someone who did not qualify, and by how much they missed. */
export interface ClosestMiss {
  name: string;
  bestMs: number;
  /** How far off the target, ms. Always > 0. */
  gapMs: number;
}

/** Everything the scene renders. Built once server-side so two screens on the
 *  same track cannot compute a different answer from the same facts. */
export interface ResultsBoardView {
  track: TrackKey;
  sessionId: string;
  heatNumber: number | null;
  /** "Blue Intermediate" — parsed from the heat's own name. */
  raceType: string | null;
  /** "Heat 59 · Blue Intermediate", or "Blue Track" with nothing to go on. */
  heatLabel: string;
  /** The timing system's own end stamp, ms. */
  endedAtMs: number;
  /** Finishing order, position ascending. */
  drivers: ResultsBoardDriver[];
  /** What this grid was racing for. Null on a Pro grid — the top of either
   *  ladder has nothing above it, and the scene shows the podium instead. */
  target: { level: QualifyTargetLevel; ms: number } | null;
  /** The subset of `drivers` that levelled up, in finishing order. */
  qualified: ResultsBoardDriver[];
  /** The nearest racer who missed, for the "so close" line. Null when nobody
   *  missed, nobody set a lap, or there was no target to miss. */
  closest: ClosestMiss | null;
  /** Fastest lap OF THE RACE — motorsport's purple, and not necessarily P1. */
  fastest: { name: string; bestMs: number } | null;
  /** Top three by finishing position, for the Pro-grid panel. */
  podium: ResultsBoardDriver[];
  /** Render the two-column layout. */
  wide: boolean;
}

/** What the timing system called this race, reduced to its type.
 *
 *  Both upstreams spell it the same way after their own prefix: the venue
 *  broadcast's `Name` is "66 - Mega Pro" and the captured frame's heatName is
 *  "Heat 66 - Mega Pro". Everything after the first " - " is the type.
 *
 *  A group event or custom race has an arbitrary name with no separator; that
 *  returns null, which correctly means "no level to qualify for" rather than a
 *  guess at one. */
export function raceTypeFromHeatName(heatName: string | null | undefined): string | null {
  if (!heatName) return null;
  const idx = heatName.indexOf(" - ");
  if (idx === -1) return null;
  const type = heatName.slice(idx + 3).trim();
  return type.length > 0 ? type : null;
}

/** "Heat 59 · Blue Intermediate". Falls back through what is actually known —
 *  a board must never print "Heat —" or "Session undefined". */
export function heatLabelFor(
  track: TrackKey,
  heatNumber: number | null,
  raceType: string | null,
): string {
  const parts: string[] = [];
  if (heatNumber !== null) parts.push(`Heat ${heatNumber}`);
  // The race type already names the track ("Blue Intermediate"), so naming the
  // track again would read "Heat 59 · Blue Track · Blue Intermediate". Without
  // a type, the track IS the only identity the row has — and heat numbers are
  // per-track, so it can never be dropped (Blue 59 and Red 59 are two races).
  parts.push(raceType ?? TRACK_LABELS[track]);
  return parts.join(" · ");
}

/** The raw driver shape the capture stores, before qualification is decided. */
export interface CapturedDriver {
  name: string;
  bestMs: number | null;
  kart: string;
  laps: number;
  position: number;
}

/**
 * Build the whole view from one captured race.
 *
 * Qualification uses the SAME at-or-under test `splitByTarget` applies — the
 * target IS the time to beat, and a racer with no lap cannot have qualified.
 */
export function buildResultsView(args: {
  track: TrackKey;
  sessionId: string;
  heatNumber: number | null;
  heatName: string | null;
  endedAtMs: number;
  drivers: CapturedDriver[];
}): ResultsBoardView {
  const raceType = raceTypeFromHeatName(args.heatName);
  const target = nextLevelTarget(args.track, raceType);
  const targetMs = target?.ms ?? null;

  const drivers: ResultsBoardDriver[] = [...args.drivers]
    .sort((a, b) => a.position - b.position)
    .map((d) => ({
      ...d,
      qualified: targetMs !== null && d.bestMs !== null && d.bestMs <= targetMs,
    }));

  const qualified = drivers.filter((d) => d.qualified);

  let closest: ClosestMiss | null = null;
  if (targetMs !== null) {
    for (const d of drivers) {
      if (d.qualified || d.bestMs === null) continue;
      const gapMs = d.bestMs - targetMs;
      // Defensive: a non-qualified driver's gap is positive by construction,
      // but a future change to the at-or-under rule must not produce a
      // negative "miss" on a wall.
      if (gapMs <= 0) continue;
      if (closest === null || gapMs < closest.gapMs) {
        closest = { name: d.name, bestMs: d.bestMs, gapMs };
      }
    }
  }

  let fastest: { name: string; bestMs: number } | null = null;
  for (const d of drivers) {
    if (d.bestMs === null) continue;
    if (fastest === null || d.bestMs < fastest.bestMs) {
      fastest = { name: d.name, bestMs: d.bestMs };
    }
  }

  return {
    track: args.track,
    sessionId: args.sessionId,
    heatNumber: args.heatNumber,
    raceType,
    heatLabel: heatLabelFor(args.track, args.heatNumber, raceType),
    endedAtMs: args.endedAtMs,
    drivers,
    target,
    qualified,
    closest,
    fastest,
    // Position 0 is the timing system's "unplaced" — a driver who never
    // crossed the line. It must never be shown as a podium finish.
    podium: drivers.filter((d) => d.position >= 1 && d.position <= 3),
    wide: drivers.length >= WIDE_GRID_FROM,
  };
}

/* ── choosing WHICH race the board is about ───────────────────────────── */

/** A race that ran on this track today, as far as any one source knows. */
export interface FinishedCandidate {
  sessionId: string;
  heatNumber: number | null;
  heatName: string | null;
  /** Null while the race is still running — such rows never become the
   *  subject, but they are carried so a caller can look for a finish marker. */
  endedAtMs: number | null;
}

/**
 * Fold what several sources say about the same race into one list.
 *
 * Three sources answer "what ran on this track today", none of them completely:
 * Pandora is current but carries no heat NAME, Neon `race_timings` carries the
 * name and survives an outage but only fills in when the bridge delivers, and
 * the Redis finish markers are seconds-fresh but have to be looked up by id.
 * Merging by session id lets each contribute what it has.
 *
 * LATER SOURCES ONLY FILL GAPS. Nothing here can blank a field an earlier
 * source supplied — the same COALESCE posture `recordRaceTiming` uses, and for
 * the same reason: a replay must only ever be able to add.
 */
export function mergeCandidates(sources: FinishedCandidate[][]): FinishedCandidate[] {
  const byId = new Map<string, FinishedCandidate>();
  for (const list of sources) {
    for (const c of list) {
      if (!c.sessionId) continue;
      const cur = byId.get(c.sessionId);
      if (!cur) {
        byId.set(c.sessionId, { ...c });
        continue;
      }
      byId.set(c.sessionId, {
        sessionId: cur.sessionId,
        heatNumber: cur.heatNumber ?? c.heatNumber,
        heatName: cur.heatName ?? c.heatName,
        endedAtMs: cur.endedAtMs ?? c.endedAtMs,
      });
    }
  }
  return [...byId.values()];
}

/**
 * The races this board would show, newest finish first.
 *
 * Ordered by when each race ENDED, never by heat number: heat numbers are
 * creation-order rather than schedule-order (a staff-inserted session takes the
 * day-max number whatever slot it runs in), so ordering by number would let an
 * inserted heat masquerade as the most recent race all night.
 */
export function rankFinished(candidates: FinishedCandidate[]): FinishedCandidate[] {
  return candidates
    .filter((c): c is FinishedCandidate & { endedAtMs: number } => c.endedAtMs !== null)
    .sort((a, b) => b.endedAtMs - a.endedAtMs);
}
