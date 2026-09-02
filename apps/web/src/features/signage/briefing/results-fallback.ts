/**
 * Final standings from sources OTHER than the timing cloud socket — pure.
 *
 * WHY (2026-09-01): webserver22:10015 went dark at 19:36 ET on a Mega night
 * and stayed dark for hours. Every standings capture rides that one socket,
 * so heats 46-66 finished in front of a "results will appear here" card while
 * the venue broadcast — carrying every lap with a name, kart and time — kept
 * flowing the whole time. The wall must never again depend on one vendor
 * relay when two other sources already hold the same answer:
 *
 *   1. Pandora's own scores (`/v2/bmi/records/scores/{loc}/{sessionId}`) —
 *      the OFFICIAL verdict: positions, laps, best times, the same numbers
 *      the level-up path reads. Wins whenever it answers.
 *   2. `race_best_laps` (Neon) — one row per (session, racer) folded live off
 *      the broadcast's TimingPassingNotification. Names, karts and best laps
 *      survive even a full vendor-cloud outage. Ranked by best lap, exactly
 *      how the vendor ranks an arrive-and-drive heat — proven identical to a
 *      real cloud capture on heat 44 of 2026-09-01, driver for driver, to the
 *      millisecond. It does not know LAP COUNTS (the table keeps only the
 *      best), so `laps` is 0 in this last resort.
 *
 * Both sources are addressed BY session id, so the heat-match gate the wire
 * capture needs (a frame could be the NEXT heat) has no equivalent here —
 * these can only ever be the session's own numbers.
 *
 * ONLY FOR A STAMPED FINISH. During the pending-finish window karts are still
 * completing their final lap; folding standings then would freeze pre-final
 * laps into the qualification board for 48h (review 2026-08-12). Callers gate
 * on the venue's ActualEnd; this module just converts.
 */
import type { ResultsDriver } from "./results-frame";

/** One row of Pandora's scores payload, as this module needs it. persId and
 *  parId are deliberately NOT here — 17-digit BMI ids must never round
 *  through a JS number, and nothing on a wall wants them (CLAUDE.md § BMI ID
 *  Precision; the server-side fetch strips them from the raw text before
 *  JSON.parse as belt-and-braces). */
export interface PandoraScoreRow {
  position: number | null;
  /** Best lap. Observed in MILLISECONDS on 2026-09-01 (67031 for a 67s Mega
   *  lap); `lapMsFromScore` sniffs the unit rather than trusting a spec. */
  bestLap: number | null;
  laps: number | null;
  alias?: string | null;
  name?: string | null;
  sessionName?: string | null;
}

/** A karting lap is seconds-to-minutes: anything under 1000 can only be a
 *  value expressed in seconds, anything at or above it only milliseconds.
 *  Zero and null both mean "never set a lap". */
export function lapMsFromScore(bestLap: number | null | undefined): number | null {
  if (bestLap == null || bestLap === 0 || !Number.isFinite(bestLap)) return null;
  return bestLap < 1000 ? Math.round(bestLap * 1000) : Math.round(bestLap);
}

/** The display name a score row carries. `alias` is what the timing screens
 *  show (the kiosk-typed racer name), so it matches the wire capture's names;
 *  `name` is the fallback. */
function scoreRowName(row: PandoraScoreRow): string {
  return (row.alias || row.name || "").trim();
}

/**
 * Pandora scores → the capture's driver shape.
 *
 * Positions come from Pandora VERBATIM — it is the official order, points and
 * all, so re-deriving it here would let the wall disagree with the record the
 * venue keeps. Rows Pandora left unplaced (position null/0) keep position 0,
 * which downstream already treats as "never crossed the line". Karts are not
 * in the payload; the caller supplies a name→kart lookup built off the
 * broadcast (empty string when even that never saw the racer).
 */
export function driversFromScores(
  rows: readonly PandoraScoreRow[],
  kartByName: ReadonlyMap<string, string>,
): ResultsDriver[] {
  const drivers: ResultsDriver[] = [];
  for (const row of rows) {
    const name = scoreRowName(row);
    if (!name) continue; // a nameless row cannot go on a wall
    drivers.push({
      name,
      bestMs: lapMsFromScore(row.bestLap),
      kart: kartByName.get(name) ?? "",
      laps: typeof row.laps === "number" && row.laps > 0 ? row.laps : 0,
      position: typeof row.position === "number" && row.position > 0 ? row.position : 0,
    });
  }
  return drivers.sort((a, b) => (a.position || Infinity) - (b.position || Infinity));
}

/** What `driversFromBestLaps` needs from a race_best_laps row. */
export interface BestLapRow {
  participantName: string;
  kart: string | null;
  bestLapMs: number;
}

/**
 * race_best_laps rows → ranked standings, best lap ascending.
 *
 * This ranking rule is not a guess: reconstructing heat 44 (2026-09-01) from
 * the same broadcast data produced the cloud capture's exact output. Lap
 * counts are unknown to this table, so `laps` is 0 across the board — the
 * scene shows a 0 there, which is the honest answer, and this source only
 * ever runs when both vendor paths are down.
 */
export function driversFromBestLaps(rows: readonly BestLapRow[]): ResultsDriver[] {
  return [...rows]
    .filter((r) => r.participantName.trim().length > 0 && r.bestLapMs > 0)
    .sort((a, b) => a.bestLapMs - b.bestLapMs)
    .map((r, i) => ({
      name: r.participantName,
      bestMs: r.bestLapMs,
      kart: r.kart ?? "",
      laps: 0,
      position: i + 1,
    }));
}

/** The heat name a scores payload carries, if any row names the session. */
export function heatNameFromScores(rows: readonly PandoraScoreRow[]): string | null {
  for (const row of rows) {
    const n = (row.sessionName || "").trim();
    if (n) return n;
  }
  return null;
}
