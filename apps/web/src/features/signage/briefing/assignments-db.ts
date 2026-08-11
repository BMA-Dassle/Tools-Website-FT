/**
 * Which briefing room each session was sent to (Neon).
 *
 * THIS IS THE DURABLE HALF of the feature, and it exists for one reason: the
 * qualification board. When a group is briefed in RED and goes racing, the board
 * that greets the NEXT group in RED has to announce who from the previous RED
 * group levelled up. Answering that needs "which session did this room brief
 * before the one it is briefing now?", which is a question about the past, and
 * Redis in this codebase is display state with a TTL — never a record.
 *
 * PERSIST AT CAPTURE (house rule, CLAUDE.md): the row is written BEFORE the Redis
 * display state, so a Redis blip loses a wall animation and never the history.
 *
 * IDS ARE TEXT. Pandora session ids are numeric today, but BMI's id space
 * exceeds Number.MAX_SAFE_INTEGER and this column is round-tripped through JSON;
 * storing it as TEXT means a 17-digit id can never silently round (house rule).
 */
import { sql, isDbConfigured } from "@ft/db";
import type { BriefingRoom, BriefingTier } from "./types";

let schemaReady = false;

async function ensureSchema(): Promise<void> {
  if (schemaReady || !isDbConfigured()) return;
  const q = sql();
  await q`
    CREATE TABLE IF NOT EXISTS briefing_assignments (
      id            BIGSERIAL PRIMARY KEY,
      venue         TEXT NOT NULL DEFAULT 'FT',
      business_day  TEXT NOT NULL,
      room          TEXT NOT NULL,
      track         TEXT NOT NULL,
      session_id    TEXT NOT NULL,
      heat_number   INTEGER,
      race_type     TEXT,
      tier          TEXT,
      mode          TEXT NOT NULL DEFAULT 'timeline',
      sent_at       TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  await q`
    CREATE INDEX IF NOT EXISTS briefing_assignments_day_idx
      ON briefing_assignments (venue, business_day, room, sent_at DESC)
  `;
  schemaReady = true;
}

export interface BriefingAssignment {
  id: string;
  venue: string;
  businessDay: string;
  room: BriefingRoom;
  track: string;
  sessionId: string;
  heatNumber: number | null;
  raceType: string | null;
  tier: BriefingTier | null;
  mode: string;
  sentAt: string;
}

function toRow(r: Record<string, unknown>): BriefingAssignment {
  return {
    // BIGSERIAL — kept as a string for the same reason session_id is TEXT.
    id: String(r.id),
    venue: String(r.venue),
    businessDay: String(r.business_day),
    room: String(r.room) as BriefingRoom,
    track: String(r.track),
    sessionId: String(r.session_id),
    heatNumber: r.heat_number == null ? null : Number(r.heat_number),
    raceType: r.race_type == null ? null : String(r.race_type),
    tier: r.tier == null ? null : (String(r.tier) as BriefingTier),
    mode: String(r.mode),
    sentAt: String(r.sent_at),
  };
}

/** Record a send. Called before the Redis write — see the header. */
export async function recordBriefingAssignment(args: {
  venue: string;
  businessDay: string;
  room: BriefingRoom;
  track: string;
  sessionId: string;
  heatNumber: number | null;
  raceType: string | null;
  tier: BriefingTier | null;
  mode: string;
}): Promise<void> {
  if (!isDbConfigured()) return;
  await ensureSchema();
  const q = sql();
  await q`
    INSERT INTO briefing_assignments
      (venue, business_day, room, track, session_id, heat_number, race_type, tier, mode)
    VALUES
      (${args.venue}, ${args.businessDay}, ${args.room}, ${args.track}, ${args.sessionId},
       ${args.heatNumber}, ${args.raceType}, ${args.tier}, ${args.mode})
  `;
}

/** Everything sent today, newest first — the control board's history strip. */
export async function listBriefingAssignments(
  venue: string,
  businessDay: string,
): Promise<BriefingAssignment[]> {
  if (!isDbConfigured()) return [];
  await ensureSchema();
  const q = sql();
  const rows = (await q`
    SELECT id, venue, business_day, room, track, session_id, heat_number, race_type, tier, mode, sent_at
    FROM briefing_assignments
    WHERE venue = ${venue} AND business_day = ${businessDay}
    ORDER BY sent_at DESC
    LIMIT 200
  `) as Array<Record<string, unknown>>;
  return rows.map(toRow);
}

/**
 * The session this room briefed BEFORE the one it is briefing now — i.e. the
 * group that is out on track and about to come back.
 *
 * `excludeSessionId` is the session currently in the room. Passing it rather
 * than "second row" is deliberate: staff sometimes re-send the same session (a
 * straggler arrives, someone presses it twice), which would otherwise push the
 * genuinely-previous group out of reach. Skipping BY ID makes repeats harmless.
 *
 * Only ever looks at `mode = 'timeline'` rows: a quals-only send is a board
 * being shown, not a group being briefed, so it must not become the thing the
 * next group's board reports on.
 */
export async function previousTimelineAssignment(
  venue: string,
  businessDay: string,
  room: BriefingRoom,
  excludeSessionId: string | null,
): Promise<BriefingAssignment | null> {
  if (!isDbConfigured()) return null;
  await ensureSchema();
  const q = sql();
  const rows = (await q`
    SELECT id, venue, business_day, room, track, session_id, heat_number, race_type, tier, mode, sent_at
    FROM briefing_assignments
    WHERE venue = ${venue}
      AND business_day = ${businessDay}
      AND room = ${room}
      AND mode = 'timeline'
      AND (${excludeSessionId}::text IS NULL OR session_id <> ${excludeSessionId})
    ORDER BY sent_at DESC
    LIMIT 1
  `) as Array<Record<string, unknown>>;
  return rows[0] ? toRow(rows[0]) : null;
}
