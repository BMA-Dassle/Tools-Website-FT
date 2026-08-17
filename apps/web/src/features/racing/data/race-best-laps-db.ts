import "server-only";

/**
 * EVERY RACER'S BEST LAP, AND THE INSTANT THEY SET IT (Neon).
 *
 * This is the one record that makes a lap findable inside a video. The standings
 * capture knows a racer's best lap but not WHEN it happened; `race_timings` knows
 * when the race ran but nothing about laps. Only `TimingPassingNotification`
 * carries both, and it lives in a Redis debug buffer that turns over in hours.
 *
 * So: one row per (race, racer), holding their fastest lap and its
 * `PassingTimeUtc`. Combined with a video's start wall clock, that locates the
 * lap in the file exactly — verified to under a second against real footage on
 * 2026-08-17.
 *
 * WHY THIS AND NOT A BIGGER QUEUE. Holding a week of the raw broadcast would be
 * ~230,000 entries and ~95 MB, of which only 10% is passings at all (SpeedChange
 * alone is a third). One row per racer per race is ~47 rows a race night — about
 * 330 a week, roughly 0.1 MB. Same answers, three orders of magnitude cheaper,
 * and permanent instead of expiring.
 *
 * IDEMPOTENT BY CONSTRUCTION, no claim key needed. The broadcast re-delivers and
 * the bridge replays, but the upsert only overwrites when the incoming lap is
 * STRICTLY FASTER — so re-processing the same passing is a no-op, and processing
 * them out of order still converges on the true best.
 *
 * NAMES, NOT PERSON IDS — matching the rest of the timing side. `ParticipantName`
 * is what a human typed at the kiosk and is often abbreviated ("Genn A"), so
 * callers join by name the way pov-overlay/overlay.ts already does.
 *
 * IDS ARE TEXT — house rule, CLAUDE.md.
 */
import { sql, isDbConfigured } from "@ft/db";
import { businessDayYmdET } from "@/lib/race-business-day";
import type { VenueLapPassing } from "../venue-broadcast";

let schemaReady = false;

async function ensureSchema(): Promise<void> {
  if (schemaReady || !isDbConfigured()) return;
  const q = sql();
  await q`
    CREATE TABLE IF NOT EXISTS race_best_laps (
      session_id       TEXT NOT NULL,
      participant_name TEXT NOT NULL,
      venue            TEXT NOT NULL DEFAULT 'FT',
      business_day     TEXT NOT NULL,
      session_name     TEXT,
      kart             TEXT,
      best_lap_ms      INTEGER NOT NULL,
      best_lap_at      TIMESTAMPTZ NOT NULL,
      recorded_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (session_id, participant_name)
    )
  `;
  // The reel's read: fastest laps for a venue across a span of days.
  await q`
    CREATE INDEX IF NOT EXISTS race_best_laps_fastest_idx
      ON race_best_laps (venue, business_day, best_lap_ms)
  `;
  schemaReady = true;
}

export interface RaceBestLap {
  sessionId: string;
  participantName: string;
  sessionName: string | null;
  businessDay: string;
  kart: string | null;
  bestLapMs: number;
  /** Epoch ms of the line crossing that COMPLETED the best lap. The lap itself
   *  occupies [bestLapAtMs − bestLapMs, bestLapAtMs]. */
  bestLapAtMs: number;
}

function toRow(r: Record<string, unknown>): RaceBestLap {
  return {
    sessionId: String(r.session_id),
    participantName: String(r.participant_name),
    sessionName: r.session_name == null ? null : String(r.session_name),
    businessDay: String(r.business_day),
    kart: r.kart == null ? null : String(r.kart),
    bestLapMs: Number(r.best_lap_ms),
    bestLapAtMs: Date.parse(String(r.best_lap_at)),
  };
}

/**
 * Fold a batch of passings into the table, keeping each racer's fastest.
 *
 * Reduced in memory first so one message carrying a racer's whole race costs one
 * statement rather than fifteen. Returns how many rows were written or improved.
 */
export async function recordLapPassings(
  passings: readonly VenueLapPassing[],
  venue = "FT",
): Promise<number> {
  if (!isDbConfigured() || passings.length === 0) return 0;

  const bestByKey = new Map<string, VenueLapPassing>();
  for (const p of passings) {
    const key = `${p.sessionId}::${p.participantName}`;
    const prev = bestByKey.get(key);
    if (!prev || p.lapTimeMs < prev.lapTimeMs) bestByKey.set(key, p);
  }

  await ensureSchema();
  const q = sql();
  let written = 0;

  for (const p of bestByKey.values()) {
    // The race's own night, from the lap's own clock — a catch-up delivery on
    // Sunday morning must still file Saturday's laps under Saturday.
    const businessDay = businessDayYmdET(new Date(p.passingAtMs));
    try {
      await q`
        INSERT INTO race_best_laps
          (session_id, participant_name, venue, business_day, session_name,
           kart, best_lap_ms, best_lap_at)
        VALUES
          (${p.sessionId}, ${p.participantName}, ${venue}, ${businessDay},
           ${p.sessionName || null}, ${p.kart || null}, ${Math.round(p.lapTimeMs)},
           ${new Date(p.passingAtMs).toISOString()})
        ON CONFLICT (session_id, participant_name) DO UPDATE SET
          best_lap_ms  = EXCLUDED.best_lap_ms,
          best_lap_at  = EXCLUDED.best_lap_at,
          kart         = COALESCE(EXCLUDED.kart, race_best_laps.kart),
          session_name = COALESCE(EXCLUDED.session_name, race_best_laps.session_name)
        WHERE EXCLUDED.best_lap_ms < race_best_laps.best_lap_ms
      `;
      written++;
    } catch (err) {
      console.error("[race-best-laps] write failed", p.sessionId, p.participantName, err);
    }
  }
  return written;
}

/** Every recorded best lap for one race, fastest first. */
export async function readRaceBestLaps(sessionId: string): Promise<RaceBestLap[]> {
  if (!isDbConfigured() || !sessionId) return [];
  await ensureSchema();
  const q = sql();
  const rows = (await q`
    SELECT session_id, participant_name, session_name, business_day, kart,
           best_lap_ms, best_lap_at
    FROM race_best_laps
    WHERE session_id = ${sessionId}
    ORDER BY best_lap_ms ASC
    LIMIT 50
  `) as Array<Record<string, unknown>>;
  return rows.map(toRow);
}

/**
 * The fastest laps across a span of business days — the reel's ranking read.
 *
 * Tier filtering is deliberately NOT done here: it is a property of
 * `session_name`, and the caller owns that rule, including the trap that
 * "Junior Pro" passes a naive Pro test.
 *
 * `toBusinessDay` is INCLUSIVE and optional, matching listRaceTimingsSince.
 */
export async function listFastestLapsSince(
  venue: string,
  fromBusinessDay: string,
  toBusinessDay?: string,
  limit = 200,
): Promise<RaceBestLap[]> {
  if (!isDbConfigured()) return [];
  await ensureSchema();
  const q = sql();
  const to = toBusinessDay ?? "9999-12-31";
  const rows = (await q`
    SELECT session_id, participant_name, session_name, business_day, kart,
           best_lap_ms, best_lap_at
    FROM race_best_laps
    WHERE venue = ${venue}
      AND business_day >= ${fromBusinessDay}
      AND business_day <= ${to}
    ORDER BY best_lap_ms ASC
    LIMIT ${Math.max(1, Math.min(1000, limit))}
  `) as Array<Record<string, unknown>>;
  return rows.map(toRow);
}
