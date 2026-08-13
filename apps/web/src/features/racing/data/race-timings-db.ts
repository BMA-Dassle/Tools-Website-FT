import "server-only";

/**
 * WHEN EACH RACE ACTUALLY RAN (Neon). The other half of the wait-time picture.
 *
 * The briefing log already answers everything that happens in the building up to
 * the point a group walks out of the briefing room. What it cannot answer is
 * "…and then how long did they wait before the flag", because the race's own
 * start and end lived only in Redis with a 12-hour TTL
 * (`briefing:race-finished:*` — display state, deliberately never an archive).
 * A question about last Saturday's average wait therefore had no data at all.
 *
 * The signal itself already arrives: the venue broadcast's `RaceFinish` carries
 * BOTH `ActualStart` and `ActualEnd` in the same record, so one row per race at
 * finish time captures the whole race window. Nothing new is integrated here —
 * this is the same webhook, writing down what it was already reading.
 *
 * ONE ROW PER RACE, UPSERTED, and every field COALESCEd on conflict so a later
 * push can only ever ADD what an earlier one lacked. The broadcast re-sends the
 * day's race list on every state change and replays it wholesale on reconnect;
 * that makes replays a FEATURE here (a bridge outage backfills itself when the
 * pipe comes back) rather than a hazard, as long as no replay can blank a stamp
 * it does not carry. Hence COALESCE, never a plain overwrite.
 *
 * THE BUSINESS DAY IS THE RACE'S OWN, derived from its start/end rather than
 * from "now" — a catch-up dump arriving Sunday morning must file Saturday's races
 * under Saturday, or every metric it feeds is wrong about which night it measured.
 *
 * NO PEOPLE. A race is a session id, a heat and two timestamps; who was in it is
 * re-readable from Pandora if a question ever needs it. Same posture as
 * briefing_assignments, for the same reason.
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
    CREATE TABLE IF NOT EXISTS race_timings (
      session_id   TEXT PRIMARY KEY,
      venue        TEXT NOT NULL DEFAULT 'FT',
      business_day TEXT NOT NULL,
      track        TEXT,
      heat_number  INTEGER,
      heat_name    TEXT,
      started_at   TIMESTAMPTZ,
      ended_at     TIMESTAMPTZ,
      recorded_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  await q`
    CREATE INDEX IF NOT EXISTS race_timings_day_idx
      ON race_timings (venue, business_day, started_at)
  `;
  schemaReady = true;
}

export interface RaceTiming {
  sessionId: string;
  businessDay: string;
  track: string | null;
  heatNumber: number | null;
  heatName: string | null;
  /** The venue's own ActualStart, ms. Null until a record carrying it arrives. */
  startedAtMs: number | null;
  /** The venue's own ActualEnd, ms. */
  endedAtMs: number | null;
}

export interface RecordRaceTimingArgs {
  venue?: string;
  sessionId: string;
  track: string | null;
  heatNumber: number | null;
  heatName: string | null;
  startedAtMs: number | null;
  endedAtMs: number | null;
}

function toRow(r: Record<string, unknown>): RaceTiming {
  return {
    sessionId: String(r.session_id),
    businessDay: String(r.business_day),
    track: r.track == null ? null : String(r.track),
    heatNumber: r.heat_number == null ? null : Number(r.heat_number),
    heatName: r.heat_name == null ? null : String(r.heat_name),
    startedAtMs: r.started_at == null ? null : Date.parse(String(r.started_at)),
    endedAtMs: r.ended_at == null ? null : Date.parse(String(r.ended_at)),
  };
}

/**
 * Write (or complete) one race's timing row.
 *
 * A record with neither stamp is not worth a row — it would be an id and two
 * nulls, and the metrics would have to filter it out anyway.
 */
export async function recordRaceTiming(args: RecordRaceTimingArgs): Promise<void> {
  if (!isDbConfigured() || !args.sessionId) return;
  if (args.startedAtMs == null && args.endedAtMs == null) return;
  await ensureSchema();

  // The night this race belongs to, from the race's own clock — see the header.
  const anchorMs = args.startedAtMs ?? args.endedAtMs ?? Date.now();
  const businessDay = businessDayYmdET(new Date(anchorMs));
  const startedAt = args.startedAtMs == null ? null : new Date(args.startedAtMs).toISOString();
  const endedAt = args.endedAtMs == null ? null : new Date(args.endedAtMs).toISOString();

  const q = sql();
  await q`
    INSERT INTO race_timings
      (session_id, venue, business_day, track, heat_number, heat_name, started_at, ended_at)
    VALUES
      (${args.sessionId}, ${args.venue ?? "FT"}, ${businessDay}, ${args.track},
       ${args.heatNumber}, ${args.heatName}, ${startedAt}, ${endedAt})
    ON CONFLICT (session_id) DO UPDATE SET
      started_at  = COALESCE(EXCLUDED.started_at, race_timings.started_at),
      ended_at    = COALESCE(EXCLUDED.ended_at, race_timings.ended_at),
      track       = COALESCE(EXCLUDED.track, race_timings.track),
      heat_number = COALESCE(EXCLUDED.heat_number, race_timings.heat_number),
      heat_name   = COALESCE(EXCLUDED.heat_name, race_timings.heat_name)
  `;
}

/** Every race on a business day, oldest first. */
export async function listRaceTimings(venue: string, businessDay: string): Promise<RaceTiming[]> {
  if (!isDbConfigured()) return [];
  await ensureSchema();
  const q = sql();
  const rows = (await q`
    SELECT session_id, business_day, track, heat_number, heat_name, started_at, ended_at
    FROM race_timings
    WHERE venue = ${venue} AND business_day = ${businessDay}
    ORDER BY started_at ASC NULLS LAST, session_id ASC
    LIMIT 500
  `) as Array<Record<string, unknown>>;
  return rows.map(toRow);
}

/**
 * A span of business days, for a rolling average. Order is the fold's problem,
 * not this query's.
 *
 * `toBusinessDay` is INCLUSIVE and optional. It exists so a caller can ask for
 * "the week BEFORE today" — the only window a today-vs-baseline comparison can
 * honestly use, since a range that ran to today would be comparing today against
 * itself.
 */
export async function listRaceTimingsSince(
  venue: string,
  fromBusinessDay: string,
  toBusinessDay?: string,
): Promise<RaceTiming[]> {
  if (!isDbConfigured()) return [];
  await ensureSchema();
  const q = sql();
  // Open-ended when no end is named — '9999-12-31' sorts above any business day
  // this venue will ever write, so one query serves both shapes.
  const to = toBusinessDay ?? "9999-12-31";
  const rows = (await q`
    SELECT session_id, business_day, track, heat_number, heat_name, started_at, ended_at
    FROM race_timings
    WHERE venue = ${venue} AND business_day >= ${fromBusinessDay} AND business_day <= ${to}
    ORDER BY business_day ASC, started_at ASC NULLS LAST
    LIMIT 2000
  `) as Array<Record<string, unknown>>;
  return rows.map(toRow);
}
