import "server-only";

/**
 * WHO DROVE WHAT, KEPT (Neon). The lap times, past 48 hours.
 *
 * The timing system's standings are captured once per heat and stored in Redis
 * under `briefing:results:{sessionId}` with a **48-hour TTL** — deliberately, because
 * that record exists to feed the welcome-back board and Redis is not a lap archive
 * (see briefing/race-results.server.ts). That was the right call for the boards and
 * the wrong one for every question that outlives a weekend:
 *
 *   • "What were the fastest laps this WEEK?" — unanswerable; the week is mostly gone.
 *   • The POV overlay resolves a racer's kart + best lap from that same record, and
 *     loses 21.8% of its cards purely to the TTL (measured over 1,379 videos, 3 race
 *     days, 2026-08-16).
 *
 * So this is the same capture, written down permanently. Nothing new is integrated:
 * `loadOrCaptureResults` already opens the socket, already parses the frame, and
 * already has the finished standings in hand. This persists what it caught.
 *
 * REDIS STAYS THE HOT PATH. Every board still reads the Redis record first; this
 * table is the archive underneath it. A Neon failure here must never cost a wall its
 * names, which is why every write is caught and logged rather than thrown.
 *
 * ONE ROW PER (RACE, DRIVER), and the capture only ever happens once per race —
 * `loadOrCaptureResults` is gated on a heat match AND `state >= 3`, then claimed, so
 * a re-run reads the stored record instead of re-capturing. The upsert is therefore
 * belt-and-braces against a replay rather than an expected path, and it COALESCEs so
 * a second write can only ever ADD what the first lacked.
 *
 * NAMES, NOT PERSON IDS — matching the capture it comes from. The owner's direction
 * for that record was "use the names directly from that leaderboard — doesn't need to
 * relate back to personId or anything", and inventing an id here would mean inventing
 * a match this data cannot actually support. Joining back to a racer is the caller's
 * problem, solved by name (see pov-overlay/overlay.ts `findDriver`, which measures
 * 0.7% failure and treats each failure as evidence of a mis-paired video).
 *
 * IDS ARE TEXT — Pandora/BMI session ids exceed Number.MAX_SAFE_INTEGER
 * (house rule, CLAUDE.md).
 */
import { sql, isDbConfigured } from "@ft/db";
import { businessDayYmdET } from "@/lib/race-business-day";

let schemaReady = false;

async function ensureSchema(): Promise<void> {
  if (schemaReady || !isDbConfigured()) return;
  const q = sql();
  await q`
    CREATE TABLE IF NOT EXISTS race_lap_results (
      session_id   TEXT NOT NULL,
      driver_name  TEXT NOT NULL,
      venue        TEXT NOT NULL DEFAULT 'FT',
      business_day TEXT NOT NULL,
      track        TEXT,
      heat_name    TEXT,
      heat_number  INTEGER,
      kart         TEXT,
      best_ms      INTEGER,
      laps         INTEGER,
      position     INTEGER,
      recorded_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (session_id, driver_name)
    )
  `;
  // THE RANKING QUERY, indexed: "fastest laps for this venue over a span of days".
  // best_ms ASC with nulls excluded is what a top-N read does, so lead with the
  // day span and carry the time.
  await q`
    CREATE INDEX IF NOT EXISTS race_lap_results_fastest_idx
      ON race_lap_results (venue, business_day, best_ms)
  `;
  schemaReady = true;
}

/** One driver's line in a finished heat. Mirrors ResultsDriver, which is the
 *  shape the capture already produces — structural, so this module does not
 *  reach into the signage feature to describe its own row. */
export interface RaceLapDriver {
  name: string;
  bestMs: number | null;
  kart: string;
  laps: number;
  position: number;
}

export interface RecordRaceLapResultsArgs {
  venue?: string;
  sessionId: string;
  /** The venue's own heat name, e.g. "Heat 66 - Mega Pro" — this is what a tier
   *  filter reads later (raceTypeFromHeatName → tierForRaceType). */
  heatName: string | null;
  heatNumber: number | null;
  track: string | null;
  /** When the standings were captured, for the business-day derivation. The
   *  race's own clock, never "now" — a catch-up write on Sunday morning must
   *  still file Saturday's race under Saturday. */
  capturedAtMs: number;
  drivers: readonly RaceLapDriver[];
}

/**
 * Persist one heat's standings.
 *
 * Row-per-driver in a loop rather than one multi-row statement: a heat is at most
 * a dozen karts and this runs once per race, so the clarity is worth more than the
 * round trips. A single driver failing must not lose the rest of the grid, so each
 * write is caught individually.
 */
export async function recordRaceLapResults(args: RecordRaceLapResultsArgs): Promise<number> {
  if (!isDbConfigured() || !args.sessionId || args.drivers.length === 0) return 0;
  await ensureSchema();

  const businessDay = businessDayYmdET(new Date(args.capturedAtMs));
  const venue = args.venue ?? "FT";
  const q = sql();
  let written = 0;

  for (const d of args.drivers) {
    const name = d.name?.trim();
    if (!name) continue; // a nameless row is timing-system noise, not a racer
    try {
      await q`
        INSERT INTO race_lap_results
          (session_id, driver_name, venue, business_day, track, heat_name,
           heat_number, kart, best_ms, laps, position)
        VALUES
          (${args.sessionId}, ${name}, ${venue}, ${businessDay}, ${args.track},
           ${args.heatName}, ${args.heatNumber}, ${d.kart || null},
           ${d.bestMs}, ${d.laps}, ${d.position})
        ON CONFLICT (session_id, driver_name) DO UPDATE SET
          best_ms     = COALESCE(EXCLUDED.best_ms, race_lap_results.best_ms),
          kart        = COALESCE(EXCLUDED.kart, race_lap_results.kart),
          laps        = GREATEST(EXCLUDED.laps, race_lap_results.laps),
          position    = COALESCE(EXCLUDED.position, race_lap_results.position),
          heat_name   = COALESCE(EXCLUDED.heat_name, race_lap_results.heat_name),
          heat_number = COALESCE(EXCLUDED.heat_number, race_lap_results.heat_number),
          track       = COALESCE(EXCLUDED.track, race_lap_results.track)
      `;
      written++;
    } catch (err) {
      console.error("[race-lap-results] driver write failed", name, err);
    }
  }
  return written;
}

export interface RaceLapResult {
  sessionId: string;
  driverName: string;
  businessDay: string;
  track: string | null;
  heatName: string | null;
  heatNumber: number | null;
  kart: string | null;
  bestMs: number | null;
  laps: number | null;
  position: number | null;
}

function toRow(r: Record<string, unknown>): RaceLapResult {
  return {
    sessionId: String(r.session_id),
    driverName: String(r.driver_name),
    businessDay: String(r.business_day),
    track: r.track == null ? null : String(r.track),
    heatName: r.heat_name == null ? null : String(r.heat_name),
    heatNumber: r.heat_number == null ? null : Number(r.heat_number),
    kart: r.kart == null ? null : String(r.kart),
    bestMs: r.best_ms == null ? null : Number(r.best_ms),
    laps: r.laps == null ? null : Number(r.laps),
    position: r.position == null ? null : Number(r.position),
  };
}

/**
 * One heat's stored standings, fastest first.
 *
 * This is the archive read that lets the POV overlay keep working after the 48h
 * Redis record has gone — same data, one TTL later.
 */
export async function readRaceLapResults(sessionId: string): Promise<RaceLapResult[]> {
  if (!isDbConfigured() || !sessionId) return [];
  await ensureSchema();
  const q = sql();
  const rows = (await q`
    SELECT session_id, driver_name, business_day, track, heat_name, heat_number,
           kart, best_ms, laps, position
    FROM race_lap_results
    WHERE session_id = ${sessionId}
    ORDER BY position ASC NULLS LAST
    LIMIT 50
  `) as Array<Record<string, unknown>>;
  return rows.map(toRow);
}

/**
 * The fastest laps over a span of business days — the weekly-reel ranking read.
 *
 * Drivers with no clean lap are excluded outright (a null best is "never set a
 * time", not "slow"). Tier filtering is deliberately NOT done here: it is a
 * property of `heat_name`, and the caller owns that rule — including the trap
 * that "Junior Pro" passes a naive Pro test.
 *
 * `toBusinessDay` is INCLUSIVE and optional, matching listRaceTimingsSince.
 */
export async function listFastestLapsSince(
  venue: string,
  fromBusinessDay: string,
  toBusinessDay?: string,
  limit = 200,
): Promise<RaceLapResult[]> {
  if (!isDbConfigured()) return [];
  await ensureSchema();
  const q = sql();
  const to = toBusinessDay ?? "9999-12-31";
  const rows = (await q`
    SELECT session_id, driver_name, business_day, track, heat_name, heat_number,
           kart, best_ms, laps, position
    FROM race_lap_results
    WHERE venue = ${venue}
      AND business_day >= ${fromBusinessDay}
      AND business_day <= ${to}
      AND best_ms IS NOT NULL
      AND best_ms > 0
    ORDER BY best_ms ASC
    LIMIT ${Math.max(1, Math.min(1000, limit))}
  `) as Array<Record<string, unknown>>;
  return rows.map(toRow);
}
