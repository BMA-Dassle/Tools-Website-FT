/**
 * The race report — one heat, everything we know, in one shape.
 *
 * ONE SHAPE, MANY DOORS (owner 2026-09-05). The same report is what the driver
 * view shows once the chequered flag lands, what a post-race text or email will
 * render, what `/racer` lists, and what a kiosk screen will show. So it is built
 * here, pure, from rows — and nothing about it knows whether it was asked for by
 * kart, by session, or by person. Addressing lives in `report.server.ts`; this
 * file only knows how to assemble one.
 *
 * IT JOINS THREE SOURCES, EACH FOR THE THING ONLY IT HAS:
 *
 *   race_lap_results  the AUTHORITATIVE finishing order, captured off the timing
 *                     socket at the flag and archived. Names, karts, positions,
 *                     best laps. It is the scoreboard, and we do not re-derive it
 *                     — a position computed from lap rows would disagree with the
 *                     wall, and the wall is what the guest saw.
 *   kart_lap          every crossing. The detail the capture has never had: lap by
 *                     lap, the consistency, where the time actually went.
 *   kart_event        the flags and incidents, so the report can say WHY a lap was
 *                     slow rather than leaving a driver to guess.
 *
 * THE JOIN IS THE KART NUMBER, and that is a deliberate choice over the name. The
 * capture stores names verbatim from the timing system ("john iacob", "Cookie
 * Monster") because the owner's direction was to use them as-is; matching those
 * to anything is lossy. Kart numbers are exact, and both sides have them.
 *
 * PURE. Feed it rows, get a report. No Redis, no Neon, no clock.
 */
import { formatLapTime, numberLaps, summarise, type LapSummary } from "./laps";
import type { DriverLap, TrackKey } from "./types";

/** A finishing line, as the archive stores it. */
export interface StandingRow {
  name: string;
  kart: string;
  bestMs: number | null;
  laps: number;
  position: number;
}

/** A crossing, as `kart_lap` stores it. */
export interface CrossingRow {
  kart: string;
  participantName: string | null;
  passingId: string;
  lapTimeMs: number | null;
  atUtc: string;
}

/** A flag or incident, as `kart_event` stores it. */
export interface EventRow {
  eventId: string;
  kind: string;
  kart: string | null;
  note: string | null;
  value: string | null;
  atMs: number;
}

/** Which events belong in a driver's story. Housekeeping is left out — nobody
 *  wants "kart reassigned" in a keepsake. */
const REPORTABLE = new Set([
  "blue",
  "caution",
  "red",
  "crash",
  "blackwhite",
  "disqualified",
  "personalBest",
  "dayRecord",
  "monthRecord",
  "everRecord",
  "didNotStart",
]);

export interface ReportDriver {
  kart: string;
  name: string;
  /** From the archived capture — the position the guest saw on the wall. */
  position: number;
  laps: DriverLap[];
  summary: LapSummary;
  /** Best-lap gap to the heat's fastest, ms. Zero for the fastest driver. */
  gapToFastestMs: number | null;
  /** Spread between their own best and worst timed lap — how consistent. */
  consistencyMs: number | null;
  /**
   * Typical spread, ignoring the one lap that went wrong.
   *
   * Best-to-worst is dominated by a single spin, which tells a racer nothing
   * about their driving. This is the gap between their fastest lap and their
   * MEDIAN one — the honest answer to "am I repeatable?".
   */
  medianGapMs: number | null;
  /**
   * How much they found over the heat: mean of the first third minus mean of
   * the last third. Positive means they got faster. Null under six timed laps,
   * where thirds are noise rather than a trend.
   */
  improvementMs: number | null;
  /** Which lap number was their best — "you were quickest on lap 7". */
  bestLapNumber: number | null;
  events: EventRow[];
  /** True when a disqualification is on their record for this heat. */
  disqualified: boolean;
}

/** What a racer is chasing next, and how close they got. */
export interface LevelUp {
  level: string;
  targetMs: number;
  /** Positive = still to find. Zero or negative = they made it. */
  gapMs: number;
  achieved: boolean;
}

export interface RaceReport {
  sessionId: string;
  sessionName: string | null;
  heatNumber: number | null;
  track: TrackKey | null;
  /** When the first crossing of the heat happened. */
  startedAtUtc: string | null;
  endedAtUtc: string | null;
  drivers: ReportDriver[];
  /** The heat's fastest lap and who set it. */
  fastestLap: { kart: string; name: string; ms: number } | null;
  /**
   * How close the field was — slowest best lap minus fastest best lap. A racer
   * reads this as "was I in a real fight or a procession?".
   */
  fieldSpreadMs: number | null;
  /** Who found the most time over the heat. Null when nobody ran enough laps. */
  mostImproved: { kart: string; name: string; ms: number } | null;
  /** Every reportable event in the heat, oldest first — the timeline. */
  timeline: EventRow[];
}

/** Mean of a slice, or null when the slice is empty. */
function mean(xs: number[]): number | null {
  if (xs.length === 0) return null;
  return Math.round(xs.reduce((a, b) => a + b, 0) / xs.length);
}

/**
 * Time found across the heat: first third's mean minus last third's.
 *
 * Thirds rather than first-lap-vs-last-lap, because a single lap is mostly
 * traffic. Under six timed laps a "third" is one or two laps and the number is
 * noise dressed as a trend, so it is withheld.
 */
export function improvementOf(timedMs: readonly number[]): number | null {
  if (timedMs.length < 6) return null;
  const n = Math.floor(timedMs.length / 3);
  const first = mean(timedMs.slice(0, n));
  const last = mean(timedMs.slice(-n));
  if (first === null || last === null) return null;
  return first - last;
}

/**
 * Gap from a driver's best lap to their MEDIAN lap — repeatability.
 *
 * Best-to-worst is dominated by the one lap where they spun, which says nothing
 * about how they drive. The median ignores that and answers "can you do it
 * again?", which is the question a racer actually improves against.
 */
export function medianGapOf(timedMs: readonly number[]): number | null {
  if (timedMs.length < 3) return null;
  const sorted = [...timedMs].sort((a, b) => a - b);
  const mid =
    sorted.length % 2
      ? sorted[(sorted.length - 1) / 2]
      : Math.round((sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2);
  return mid - sorted[0];
}

export function parseHeatNumber(heatName: string | null): number | null {
  if (!heatName) return null;
  const m = /(?:\[HEAT\]|Heat)?\s*(\d+)\s*-/.exec(heatName);
  return m ? Number(m[1]) : null;
}

export function buildReport(args: {
  sessionId: string;
  sessionName: string | null;
  track: TrackKey | null;
  standings: readonly StandingRow[];
  crossings: readonly CrossingRow[];
  events: readonly EventRow[];
}): RaceReport {
  const { sessionId, sessionName, track, standings, crossings, events } = args;

  const byKart = new Map<string, CrossingRow[]>();
  for (const c of crossings) {
    const list = byKart.get(c.kart);
    if (list) list.push(c);
    else byKart.set(c.kart, [c]);
  }

  const eventsByKart = new Map<string, EventRow[]>();
  const timeline: EventRow[] = [];
  for (const e of events) {
    if (!REPORTABLE.has(e.kind)) continue;
    timeline.push(e);
    if (!e.kart) continue;
    const list = eventsByKart.get(e.kart);
    if (list) list.push(e);
    else eventsByKart.set(e.kart, [e]);
  }
  timeline.sort((a, b) => a.atMs - b.atMs);

  /**
   * The scoreboard drives the roster. A kart with crossings but no standing row
   * means the capture missed it (a heat that never reached `state >= 3`, or a
   * driver added after the flag) — it is still added, at the end, rather than
   * dropped: a driver whose laps we have but whose position we do not is better
   * served by "we don't know where you finished" than by not existing.
   */
  const rows: ReportDriver[] = [];
  const seen = new Set<string>();

  const makeDriver = (kart: string, name: string, position: number): ReportDriver => {
    seen.add(kart);
    const laps = numberLaps(byKart.get(kart) ?? []);
    const summary = summarise(laps);
    const own = eventsByKart.get(kart) ?? [];
    const best = summary.best?.lapTimeMs ?? null;
    const worst = summary.worst?.lapTimeMs ?? null;
    const timedMs = summary.timed.map((l) => l.lapTimeMs as number);
    return {
      kart,
      name,
      position,
      laps,
      summary,
      gapToFastestMs: null, // filled once the heat's fastest is known
      consistencyMs: best !== null && worst !== null ? worst - best : null,
      medianGapMs: medianGapOf(timedMs),
      improvementMs: improvementOf(timedMs),
      bestLapNumber: summary.best?.lapNumber ?? null,
      events: own,
      disqualified: own.some((e) => e.kind === "disqualified"),
    };
  };

  for (const s of [...standings].sort((a, b) => a.position - b.position)) {
    rows.push(makeDriver(s.kart, s.name, s.position));
  }
  for (const kart of byKart.keys()) {
    if (seen.has(kart)) continue;
    const name =
      byKart.get(kart)?.find((c) => c.participantName)?.participantName ?? `Kart ${kart}`;
    // Position 0 reads as "unplaced" and sorts last.
    rows.push(makeDriver(kart, name, 0));
  }
  rows.sort((a, b) => (a.position || 999) - (b.position || 999));

  // Fastest lap of the heat, from OUR crossings — the archive's best_ms agrees,
  // but the crossings also tell us which lap it was.
  let fastest: RaceReport["fastestLap"] = null;
  for (const d of rows) {
    const ms = d.summary.best?.lapTimeMs ?? null;
    if (ms === null) continue;
    if (fastest === null || ms < fastest.ms) fastest = { kart: d.kart, name: d.name, ms };
  }
  if (fastest) {
    for (const d of rows) {
      const ms = d.summary.best?.lapTimeMs ?? null;
      d.gapToFastestMs = ms === null ? null : ms - fastest.ms;
    }
  }

  // How close the field was, and who found the most over the heat. Both read
  // off the drivers who actually set a time — a DNS must not widen the spread.
  const bests = rows
    .map((d) => d.summary.best?.lapTimeMs ?? null)
    .filter((ms): ms is number => ms !== null);
  const fieldSpreadMs = bests.length >= 2 ? Math.max(...bests) - Math.min(...bests) : null;

  let mostImproved: RaceReport["mostImproved"] = null;
  for (const d of rows) {
    if (d.improvementMs === null || d.improvementMs <= 0) continue;
    if (mostImproved === null || d.improvementMs > mostImproved.ms) {
      mostImproved = { kart: d.kart, name: d.name, ms: d.improvementMs };
    }
  }

  const allTimes = crossings.map((c) => c.atUtc).sort();

  return {
    sessionId,
    sessionName,
    heatNumber: parseHeatNumber(sessionName),
    track,
    startedAtUtc: allTimes[0] ?? null,
    endedAtUtc: allTimes[allTimes.length - 1] ?? null,
    drivers: rows,
    fastestLap: fastest,
    fieldSpreadMs,
    mostImproved,
    timeline,
  };
}

/**
 * What this driver is chasing next, from the SAME cutoffs the kiosk sheet and
 * the post-heat level-up text use (`~/features/racing/qualify`). Reused rather
 * than restated: a report promising a different time from the sign-in screen
 * would be worse than one promising nothing.
 *
 * The heat name carries both halves the lookup needs — "65 - Blue Starter" is
 * the track AND the race type — so it is passed for both.
 */
export function levelUpFor(
  report: RaceReport,
  driver: ReportDriver,
  nextLevelTarget: (
    track: string,
    raceType: string | null | undefined,
  ) => { level: string; ms: number } | null,
): LevelUp | null {
  const best = driver.summary.best?.lapTimeMs ?? null;
  if (best === null || !report.sessionName) return null;
  const target = nextLevelTarget(report.sessionName, report.sessionName);
  if (!target) return null;
  return {
    level: target.level,
    targetMs: target.ms,
    gapMs: best - target.ms,
    achieved: best <= target.ms,
  };
}

/** One driver out of a report, for the personal view. */
export function driverInReport(report: RaceReport, kart: string): ReportDriver | null {
  return report.drivers.find((d) => d.kart === kart) ?? null;
}

/**
 * The one-line summary a text message opens with.
 *
 * Deliberately here rather than in a messaging module: the wording must not
 * drift between the SMS, the email and the screen, and this is the only place
 * that knows how to phrase a result.
 */
export function headline(report: RaceReport, kart: string): string {
  const d = driverInReport(report, kart);
  if (!d) return `${report.sessionName ?? "Your race"} — results`;
  const heat = report.heatNumber
    ? `Heat ${report.heatNumber}`
    : (report.sessionName ?? "Your race");
  if (d.disqualified)
    return `${heat}: disqualified. Best lap ${formatLapTime(d.summary.best?.lapTimeMs ?? null)}.`;
  const best = formatLapTime(d.summary.best?.lapTimeMs ?? null);
  const place = d.position > 0 ? `P${d.position}` : "unplaced";
  return `${heat}: ${place} of ${report.drivers.length}, best lap ${best}.`;
}
