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
 * IDS ARE TEXT. Pandora session ids are numeric today, but BMI's id space exceeds
 * Number.MAX_SAFE_INTEGER and this column is round-tripped through JSON; storing it
 * as TEXT means a 17-digit id can never silently round (house rule, CLAUDE.md).
 *
 * WHICH GROUP WENT TO WHICH ROOM — that is what a row here IS, and the owner asked
 * for it to be kept ("we will use those in future"). A SESSION IS A GROUP: heat
 * number, race type, track, room, which film, and when. That answers the question
 * without naming anybody.
 *
 * NO ROSTER, deliberately. A per-racer list was added here and then removed the
 * same day (owner 2026-08-11: "why do we need to keep track of the full group
 * roster?") — nothing on a briefing screen uses it, so it was person-level data
 * stored on the chance it might be wanted, which is the wrong default. If a future
 * report genuinely needs the racers, the roster can be re-read from Pandora against
 * `session_id`, which is the durable key this row already keeps.
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
  /**
   * WHO RAN THE GROUP (2026-09-03). Added by ALTER rather than in the CREATE
   * above, because the table is long since live — the CREATE only ever runs on
   * a fresh database.
   *
   * NULLABLE ON PURPOSE, and it will stay that way: every row written before
   * this existed has no staff member, and a send can still legitimately go
   * unattributed when 7shifts is unreachable (see the prompt's fail-open path).
   * A NOT NULL here would turn an outage into a refused briefing.
   *
   * `staff_user_id` is the 7shifts USER id, not the punch ID — punch IDs are
   * reissued when someone leaves, so a report joining on one would attribute
   * last season's races to this season's new hire. The first name is
   * denormalised beside it because that is what screens show, and resolving it
   * later would mean a 7shifts call per historical row.
   */
  await q`ALTER TABLE briefing_assignments ADD COLUMN IF NOT EXISTS staff_user_id INTEGER`;
  await q`ALTER TABLE briefing_assignments ADD COLUMN IF NOT EXISTS staff_first_name TEXT`;
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
  /** 7shifts user id of the staff member running this group. Null pre-2026-09-03. */
  staffUserId: number | null;
  /** Their first name — the only part any screen shows. */
  staffFirstName: string | null;
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
    staffUserId: r.staff_user_id == null ? null : Number(r.staff_user_id),
    staffFirstName: r.staff_first_name == null ? null : String(r.staff_first_name),
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
  /** Who ran it. Null when 7shifts could not name them — never a reason to refuse. */
  staffUserId?: number | null;
  staffFirstName?: string | null;
}): Promise<void> {
  if (!isDbConfigured()) return;
  await ensureSchema();
  const q = sql();
  await q`
    INSERT INTO briefing_assignments
      (venue, business_day, room, track, session_id, heat_number, race_type, tier, mode,
       staff_user_id, staff_first_name)
    VALUES
      (${args.venue}, ${args.businessDay}, ${args.room}, ${args.track}, ${args.sessionId},
       ${args.heatNumber}, ${args.raceType}, ${args.tier}, ${args.mode},
       ${args.staffUserId ?? null}, ${args.staffFirstName ?? null})
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
    SELECT id, venue, business_day, room, track, session_id, heat_number, race_type, tier, mode,
           sent_at, staff_user_id, staff_first_name
    FROM briefing_assignments
    WHERE venue = ${venue} AND business_day = ${businessDay}
    ORDER BY sent_at DESC
    LIMIT 200
  `) as Array<Record<string, unknown>>;
  return rows.map(toRow);
}
