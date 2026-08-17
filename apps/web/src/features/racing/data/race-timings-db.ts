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
  /**
   * DID THIS RACE GET STOPPED? Added 2026-08-17 for the POV highlight reel, which
   * must not put a red-flagged heat on a marketing wall.
   *
   * The signal was already arriving and already parsed — `RaceStop` (State:
   * "Paused") comes over the venue broadcast and `extractRaceStops` has read it
   * since the race clock was built. What was missing was anywhere to KEEP it: the
   * accurate figure lives in Redis as `kart:raceclock:{raceId}.pausedTotalMs` and
   * is gone inside 90 minutes, so "was last Tuesday's heat 44 stopped?" had no
   * answer at all.
   *
   * ADD COLUMN IF NOT EXISTS rather than a migration file: this table self-creates
   * (see above) and a deploy must be able to land on a database that already has
   * the old shape.
   *
   * `duration_ms` rides along because the finish record has carried it all along
   * and it is the cross-check on the pause columns — a wall-clock span far longer
   * than the race duration is a pause we may have missed to a bridge outage.
   */
  await q`ALTER TABLE race_timings ADD COLUMN IF NOT EXISTS pause_count INTEGER NOT NULL DEFAULT 0`;
  await q`ALTER TABLE race_timings ADD COLUMN IF NOT EXISTS first_paused_at TIMESTAMPTZ`;
  await q`ALTER TABLE race_timings ADD COLUMN IF NOT EXISTS duration_ms BIGINT`;
  /**
   * THE SLOT THE HEAT WAS SOLD AS. Added 2026-08-17 so "are we on time" can be
   * answered from our own data instead of an outside service.
   *
   * NO BACKFILL IS POSSIBLE. The venue broadcast has carried `ScheduledStart` all
   * along and we parsed everything except it, so every row written before this
   * deploy has a real start and a null slot — permanently. The raw messages live
   * in a 5000-entry Redis FIFO that holds roughly one trading day, so only the
   * most recent night could ever be reconstructed, and only if someone does it
   * within hours. Any query over this column MUST tolerate null and report the
   * `n` it actually had; treating a null slot as "on time" would silently score
   * every pre-2026-08-17 night as perfect.
   */
  await q`ALTER TABLE race_timings ADD COLUMN IF NOT EXISTS scheduled_start TIMESTAMPTZ`;
  await q`ALTER TABLE race_timings ADD COLUMN IF NOT EXISTS scheduled_end TIMESTAMPTZ`;
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
  /**
   * How many times this race was stopped. **0 is only trustworthy for races that
   * ran after 2026-08-17** — nothing recorded pauses before that, so an older row
   * reads 0 because nobody was looking, not because the race ran clean.
   */
  pauseCount: number;
  /** First pause, by MESSAGE ARRIVAL time — `RaceStop` carries no timestamp of
   *  its own (see extractRaceStops). Honest to the pipe's delivery lag. */
  firstPausedAtMs: number | null;
  /** The venue's own DurationTime, ms — racing time, excluding pauses. */
  durationMs: number | null;
  /**
   * The slot this heat was sold as (the venue's `ScheduledStart`).
   *
   * **Null for every race before 2026-08-17** — see ensureSchema. It is a
   * CHECK-IN time, not a green-flag time; `startedAtMs - scheduledStartMs` is the
   * briefing pipeline, not lateness (features/racing/on-time.ts).
   */
  scheduledStartMs: number | null;
  /** The slot's own end — start→end is the printed grid spacing. */
  scheduledEndMs: number | null;
}

export interface RecordRaceTimingArgs {
  venue?: string;
  sessionId: string;
  track: string | null;
  heatNumber: number | null;
  heatName: string | null;
  startedAtMs: number | null;
  endedAtMs: number | null;
  /** The venue's own DurationTime, ms. Absent on records that do not carry it. */
  durationMs?: number | null;
  /** The venue's own ScheduledStart/End, ms. Absent on records predating the
   *  parse, so both COALESCE like every other field here. */
  scheduledStartMs?: number | null;
  scheduledEndMs?: number | null;
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
    pauseCount: r.pause_count == null ? 0 : Number(r.pause_count),
    firstPausedAtMs: r.first_paused_at == null ? null : Date.parse(String(r.first_paused_at)),
    durationMs: r.duration_ms == null ? null : Number(r.duration_ms),
    scheduledStartMs: r.scheduled_start == null ? null : Date.parse(String(r.scheduled_start)),
    scheduledEndMs: r.scheduled_end == null ? null : Date.parse(String(r.scheduled_end)),
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
  const scheduledStart =
    args.scheduledStartMs == null ? null : new Date(args.scheduledStartMs).toISOString();
  const scheduledEnd =
    args.scheduledEndMs == null ? null : new Date(args.scheduledEndMs).toISOString();

  const q = sql();
  await q`
    INSERT INTO race_timings
      (session_id, venue, business_day, track, heat_number, heat_name,
       started_at, ended_at, duration_ms, scheduled_start, scheduled_end)
    VALUES
      (${args.sessionId}, ${args.venue ?? "FT"}, ${businessDay}, ${args.track},
       ${args.heatNumber}, ${args.heatName}, ${startedAt}, ${endedAt},
       ${args.durationMs ?? null}, ${scheduledStart}, ${scheduledEnd})
    ON CONFLICT (session_id) DO UPDATE SET
      started_at      = COALESCE(EXCLUDED.started_at, race_timings.started_at),
      ended_at        = COALESCE(EXCLUDED.ended_at, race_timings.ended_at),
      track           = COALESCE(EXCLUDED.track, race_timings.track),
      heat_number     = COALESCE(EXCLUDED.heat_number, race_timings.heat_number),
      heat_name       = COALESCE(EXCLUDED.heat_name, race_timings.heat_name),
      duration_ms     = COALESCE(EXCLUDED.duration_ms, race_timings.duration_ms),
      scheduled_start = COALESCE(EXCLUDED.scheduled_start, race_timings.scheduled_start),
      scheduled_end   = COALESCE(EXCLUDED.scheduled_end, race_timings.scheduled_end)
  `;
}

/**
 * Write down that a race was STOPPED.
 *
 * Separate from recordRaceTiming because the semantics are opposite: that one
 * COALESCEs (a replay may only ever fill a gap), while a pause must ACCUMULATE —
 * a race stopped twice is a different race from one stopped once. Folding both
 * into a single upsert would force one of them to lie.
 *
 * THE CALLER OWNS DUPLICATE SUPPRESSION. The broadcast re-sends the whole day's
 * race list on every state change, so a paused race's `RaceStop` record arrives
 * in EVERY push until it resumes — incrementing on each one would count a single
 * red flag dozens of times. race-finish.server.ts claims per (raceId,
 * recordVersion) before calling this; see recordRaceStops there.
 *
 * The row may not exist yet: a pause can be processed before the start write
 * lands, so this INSERTs a partial row rather than dropping the fact.
 */
export async function recordRacePause(args: {
  venue?: string;
  sessionId: string;
  track: string | null;
  heatNumber: number | null;
  heatName: string | null;
  /** The race's own ActualStart, for the business-day anchor — `RaceStop`
   *  carries it unchanged through a pause. */
  startedAtMs: number | null;
  /** Message ARRIVAL time. `RaceStop` stamps no time of its own. */
  pausedAtMs: number;
}): Promise<void> {
  if (!isDbConfigured() || !args.sessionId) return;
  await ensureSchema();

  const anchorMs = args.startedAtMs ?? args.pausedAtMs;
  const businessDay = businessDayYmdET(new Date(anchorMs));
  const startedAt = args.startedAtMs == null ? null : new Date(args.startedAtMs).toISOString();
  const pausedAt = new Date(args.pausedAtMs).toISOString();

  const q = sql();
  await q`
    INSERT INTO race_timings
      (session_id, venue, business_day, track, heat_number, heat_name,
       started_at, pause_count, first_paused_at)
    VALUES
      (${args.sessionId}, ${args.venue ?? "FT"}, ${businessDay}, ${args.track},
       ${args.heatNumber}, ${args.heatName}, ${startedAt}, 1, ${pausedAt})
    ON CONFLICT (session_id) DO UPDATE SET
      pause_count     = race_timings.pause_count + 1,
      first_paused_at = COALESCE(race_timings.first_paused_at, EXCLUDED.first_paused_at),
      started_at      = COALESCE(race_timings.started_at, EXCLUDED.started_at),
      track           = COALESCE(race_timings.track, EXCLUDED.track),
      heat_number     = COALESCE(race_timings.heat_number, EXCLUDED.heat_number),
      heat_name       = COALESCE(race_timings.heat_name, EXCLUDED.heat_name)
  `;
}

/** Every race on a business day, oldest first. */
export async function listRaceTimings(venue: string, businessDay: string): Promise<RaceTiming[]> {
  if (!isDbConfigured()) return [];
  await ensureSchema();
  const q = sql();
  const rows = (await q`
    SELECT session_id, business_day, track, heat_number, heat_name, started_at, ended_at,
           pause_count, first_paused_at, duration_ms, scheduled_start, scheduled_end
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
    SELECT session_id, business_day, track, heat_number, heat_name, started_at, ended_at,
           pause_count, first_paused_at, duration_ms, scheduled_start, scheduled_end
    FROM race_timings
    WHERE venue = ${venue} AND business_day >= ${fromBusinessDay} AND business_day <= ${to}
    ORDER BY business_day ASC, started_at ASC NULLS LAST
    LIMIT 2000
  `) as Array<Record<string, unknown>>;
  return rows.map(toRow);
}
