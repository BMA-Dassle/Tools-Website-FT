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

/**
 * BACK-FILL WHO RAN A GROUP, onto a row already written.
 *
 * THE ROW IS WRITTEN BEFORE THE HOST IS KNOWN, and that is the normal case, not
 * an edge one: `recordBriefingAssignment` runs at the PULL, while most groups
 * are claimed at Start video a minute later. Without this, the durable record
 * stayed null for 24 of 25 groups on 2026-09-04 while Redis knew every one of
 * them — and the welcome-back board, which reads the row, greeted them by
 * nobody.
 *
 * FIRST CLAIM WINS HERE TOO (`staff_user_id IS NULL`), matching the NX on the
 * Redis key, so a later press cannot rewrite the record of who ran the group.
 *
 * Scoped to the session's OWN rows: one group can occupy two rows on a Mega
 * night (both rooms), and both should name the same person.
 */
export async function backfillAssignmentStaff(
  sessionId: string,
  staffUserId: number,
  staffFirstName: string,
): Promise<void> {
  if (!isDbConfigured() || !sessionId) return;
  await ensureSchema();
  const q = sql();
  await q`
    UPDATE briefing_assignments
    SET staff_user_id = ${staffUserId}, staff_first_name = ${staffFirstName}
    WHERE session_id = ${sessionId} AND staff_user_id IS NULL
  `;
}

/**
 * REWRITE WHO RAN A GROUP — the hand-over's durable half.
 *
 * THE ONE WRITE HERE WITHOUT `staff_user_id IS NULL`, and it is deliberate.
 * `backfillAssignmentStaff` above defers to the first claim on purpose; this is
 * the path a person explicitly confirmed in a modal ("change the group to
 * Grace?"), so it must overwrite or it is not a hand-over at all. Everything
 * else that touches this column still defers.
 *
 * EVERY ROW OF THE SESSION, because a Mega night puts one group in both rooms
 * and a hand-over that fixed only one of them would leave the two rows naming
 * different people for the same briefing.
 *
 * RETURNS WHAT IT CHANGED so the caller can log the hand-over against the right
 * room and heat without a second SELECT — and so an empty array can be told
 * apart from a write that landed, which is how the caller knows whether a
 * durable record exists at all.
 */
export async function setAssignmentStaff(
  sessionId: string,
  staffUserId: number,
  staffFirstName: string,
): Promise<BriefingAssignment[]> {
  if (!isDbConfigured() || !sessionId) return [];
  await ensureSchema();
  const q = sql();
  const rows = (await q`
    UPDATE briefing_assignments
    SET staff_user_id = ${staffUserId}, staff_first_name = ${staffFirstName}
    WHERE session_id = ${sessionId}
    RETURNING id, venue, business_day, room, track, session_id, heat_number, race_type, tier,
              mode, sent_at, staff_user_id, staff_first_name
  `) as Array<Record<string, unknown>>;
  return rows.map(toRow);
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

/**
 * HOW MANY GROUPS EACH PERSON BRIEFED ON A DAY — grouped in Postgres.
 *
 * WHO ASKS: the HeadPinz portal's pit board TV, once every thirty seconds, for
 * one number per person. It has no use for the 200-row history
 * `listBriefingAssignments` returns, and folding that list in JS would ship a
 * day of rows across the wire to produce a handful of integers.
 *
 * COUNT(DISTINCT session_id), NOT COUNT(*). A Mega-night group occupies two
 * rows — one per room — and is ONE group briefed, not two. Counting rows would
 * quietly double the busiest nights, which are exactly the ones anybody looks
 * at this number for.
 *
 * UNATTRIBUTED IS REPORTED, NEVER FOLDED INTO A ZERO. Every row written before
 * 2026-09-03 has no staff member, and a send can still legitimately go
 * unattributed today (see the column's own note above). A caller that dropped
 * those sessions would show a night nobody identified themselves on as a night
 * nobody briefed.
 *
 * ── AND WHEN EACH OF THEM LAST CAME FREE (2026-09-10) ───────────────────────
 *
 * `free_since_epoch` is when this person's most recent group's KARTS CAME BACK
 * — the "Race returned" press, which `briefing_events` already records as a
 * `pitted` row. It is what the Track Ops strip now sorts on: longest idle goes
 * to the next group, rather than the person who has briefed the most (owner
 * 2026-09-10, after a night where one marshal ran 17 groups and another ran 2).
 *
 * PIT CLEAR, NOT `sent_at`, AND THE DIFFERENCE IS ~19 MINUTES. `sent_at` is
 * when they LEFT with the group; the measured average round trip is 18-21
 * minutes. Sorting on either gives nearly the same ORDER, but only this one
 * gives a number the desk can read as "how long have they been standing
 * there", which is the whole point of putting it on the pill.
 *
 * NO NEW COLUMN, AND IT WORKS BACKWARDS. Both facts are already recorded and
 * always have been: the `pitted` row is insurance-grade and session-keyed, and
 * `staff_user_id` above says whose group that session was. The join is the
 * only thing that was missing. Measured coverage when this shipped: 29/31
 * groups on 09-10, 53/53 on 09-09, 48/48 on 09-08, 90/91 on 09-07.
 *
 * A LATERAL, so the `COUNT(DISTINCT session_id)` above is untouched — it
 * contributes exactly one row per assignment, which is what a plain join to an
 * events table would NOT have done (a session with two `pitted` rows would
 * have counted as two groups).
 *
 * NULL MEANS "NO STAMP", AND THE FOLD READS IT AS "LONGEST WAITING". Either
 * they have not taken a group tonight, or the press was missed on the one they
 * did (2-3% of groups). Both are handled the same way, deliberately: crew-list
 * puts them at the front of the queue, which errs towards giving somebody a
 * group rather than skipping them.
 */
/**
 * A Postgres `EXTRACT(EPOCH …)` to epoch milliseconds, or null.
 *
 * THE ARITHMETIC IS DONE IN SQL ON PURPOSE. The other timestamp on this table
 * is read with `Date.parse(String(row.sent_at))`, which works only because V8
 * happens to be lenient about Postgres's space-separated `2026-09-10 20:31:54+00`.
 * That is a coincidence to rely on once, not in a value that feeds a sort.
 *
 * AND THE GUARD IS THE POINT. Without `isFinite` a bad read becomes `NaN`, and
 * a `NaN` in the comparator crew-list sorts with is not a wrong order — it is
 * an INCONSISTENT one, which scrambles the list differently on every poll and
 * looks like a rendering bug rather than a data one.
 */
function epochSecondsToMs(raw: unknown): number | null {
  if (raw == null) return null;
  const seconds = Number(raw);
  return Number.isFinite(seconds) ? Math.round(seconds * 1000) : null;
}

export async function countBriefingsByStaff(
  venue: string,
  businessDay: string,
): Promise<{
  staff: Array<{
    userId: number;
    firstName: string | null;
    briefed: number;
    freeSinceMs: number | null;
  }>;
  unattributed: number;
}> {
  if (!isDbConfigured()) return { staff: [], unattributed: 0 };
  await ensureSchema();
  const q = sql();
  const rows = (await q`
    SELECT a.staff_user_id,
           a.staff_first_name,
           COUNT(DISTINCT a.session_id) AS briefed,
           EXTRACT(EPOCH FROM MAX(p.at)) AS free_since_epoch
    FROM briefing_assignments a
    LEFT JOIN LATERAL (
      SELECT MAX(e.at) AS at
      FROM briefing_events e
      WHERE e.session_id = a.session_id AND e.action = 'pitted'
    ) p ON TRUE
    WHERE a.venue = ${venue}
      AND a.business_day = ${businessDay}
      AND a.staff_user_id IS NOT NULL
    GROUP BY a.staff_user_id, a.staff_first_name
    ORDER BY briefed DESC, a.staff_first_name
  `) as Array<Record<string, unknown>>;
  const unattributedRows = (await q`
    SELECT COUNT(DISTINCT session_id) AS unattributed
    FROM briefing_assignments
    WHERE venue = ${venue} AND business_day = ${businessDay} AND staff_user_id IS NULL
  `) as Array<Record<string, unknown>>;

  return {
    /**
     * NUMBERS, not strings. `Number()` is forbidden on a BMI id and safe here:
     * these are a 7shifts user id and a count of groups in one evening, neither
     * of which comes within nine orders of magnitude of MAX_SAFE_INTEGER. The
     * driver hands back `COUNT(...)` as a bigint string, so the cast is what
     * makes the JSON a number instead of `"7"`.
     */
    staff: rows.map((r) => ({
      userId: Number(r.staff_user_id),
      firstName: r.staff_first_name == null ? null : String(r.staff_first_name),
      briefed: Number(r.briefed),
      freeSinceMs: epochSecondsToMs(r.free_since_epoch),
    })),
    unattributed: Number(unattributedRows[0]?.unattributed ?? 0),
  };
}
