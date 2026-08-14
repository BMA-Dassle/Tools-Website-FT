/**
 * THE BRIEFING-ROOM LOG (Neon). Append-only, insurance-grade.
 *
 * WHY IT EXISTS (owner 2026-08-12): "for insurance purposes, record when each
 * session is briefed and the time they're in the room. That needs to be in Neon.
 * Basically we can record all actions but this is the most important part."
 *
 * The question this table has to answer, possibly years later and possibly to
 * somebody's lawyer: *did the group in session 24 on 12 August receive the safety
 * briefing, which film, and how long were they in that room?* Before this, only
 * half of it was recorded — `briefing_assignments` stamps the SEND, and everything
 * after (the film rolling, its length, a replay, the room being released) lived in
 * Redis display state with a TTL measured in minutes. An insurance record cannot be
 * a cache entry.
 *
 * APPEND-ONLY, DELIBERATELY. Every staff action is one INSERT and no row is ever
 * updated or deleted:
 *
 *   sent       the group was sent to the room and walked in
 *   started    staff rolled the film — carries WHICH film and its length
 *   restarted  the film was played again from the top (latecomers, a re-show)
 *   photo      a camera still of the room, taken as the film started — carries
 *              the blob URL. Its OWN row rather than a column on `started`,
 *              because the picture is taken after the film is already rolling and
 *              this table is append-only: back-filling a stored row would be an
 *              UPDATE, and an editable log is not evidence.
 *   ended      the room was released: staff cleared it, or another group took it
 *
 * A log you can rewrite is not evidence. It also means no write here can race
 * another, no row needs a lock, and a re-send that reuses a room is simply more
 * rows in order.
 *
 * NOTHING DERIVABLE IS STORED — no duration column, no "film completed" flag. Time
 * in the room is `ended.at − sent.at`, and the film's natural finish is
 * `started.at + video_ms + the helmet phase`. Both are computed at read time by
 * briefing-log.ts, which is pure and tested. A denormalised duration would be one
 * more thing that can be wrong, and being wrong is the one thing this table cannot
 * afford.
 *
 * NO NAMES, same posture as briefing_assignments: a SESSION is the group. The
 * roster is re-readable from Pandora against `session_id` if a claim ever needs
 * individuals, so this table holds no person-level data at all.
 *
 * IDS ARE TEXT — Pandora ids are numeric today but BMI's id space exceeds
 * Number.MAX_SAFE_INTEGER (house rule, CLAUDE.md).
 */
import { sql, isDbConfigured } from "@ft/db";
import type { BriefingRoom, BriefingTier } from "./types";

let schemaReady = false;

async function ensureSchema(): Promise<void> {
  if (schemaReady || !isDbConfigured()) return;
  const q = sql();
  await q`
    CREATE TABLE IF NOT EXISTS briefing_events (
      id            BIGSERIAL PRIMARY KEY,
      venue         TEXT NOT NULL DEFAULT 'FT',
      business_day  TEXT NOT NULL,
      room          TEXT NOT NULL,
      track         TEXT,
      session_id    TEXT NOT NULL,
      heat_number   INTEGER,
      race_type     TEXT,
      tier          TEXT,
      action        TEXT NOT NULL,
      at            TIMESTAMPTZ NOT NULL DEFAULT now(),
      video_url     TEXT,
      video_ms      INTEGER,
      photo_url     TEXT,
      reason        TEXT,
      -- WAIT-TIME ANCHORS, on the sent row only. Both are facts we can observe
      -- exactly once: called_at lives in a Redis record that ages out ~20
      -- minutes after the call, and the roster's check-in stamps stop being
      -- readable when Pandora drops the session. Neither is derivable later, so
      -- neither violates the no-derived-columns rule above.
      called_at        TIMESTAMPTZ,
      checkin_first_at TIMESTAMPTZ,
      checkin_last_at  TIMESTAMPTZ,
      checkin_in       INTEGER,
      checkin_total    INTEGER
    )
  `;
  // Added 2026-08-12, after the table already existed on production — CREATE TABLE
  // IF NOT EXISTS above is a no-op there, so the column has to be added on its own.
  await q`ALTER TABLE briefing_events ADD COLUMN IF NOT EXISTS photo_url TEXT`;
  await q`ALTER TABLE briefing_events ADD COLUMN IF NOT EXISTS called_at TIMESTAMPTZ`;
  await q`ALTER TABLE briefing_events ADD COLUMN IF NOT EXISTS checkin_first_at TIMESTAMPTZ`;
  await q`ALTER TABLE briefing_events ADD COLUMN IF NOT EXISTS checkin_last_at TIMESTAMPTZ`;
  await q`ALTER TABLE briefing_events ADD COLUMN IF NOT EXISTS checkin_in INTEGER`;
  await q`ALTER TABLE briefing_events ADD COLUMN IF NOT EXISTS checkin_total INTEGER`;
  // The day view (the desk's log strip, and any later report) and the
  // single-session lookup an insurance question actually arrives as.
  await q`
    CREATE INDEX IF NOT EXISTS briefing_events_day_idx
      ON briefing_events (venue, business_day, at)
  `;
  await q`
    CREATE INDEX IF NOT EXISTS briefing_events_session_idx
      ON briefing_events (session_id, at)
  `;
  schemaReady = true;
}

/** What happened. See the header for what each one means.
 *  `pitted` (2026-08-13) is the pit lane's "race returned" stamp — the group's
 *  karts are fully back in and the lane is safe to seat again. It rides this
 *  same log because it is one more moment in a session's lifecycle, keyed to
 *  the room the group hands kit back into.
 *  `audio-pre` / `audio-post` (2026-08-14) are the pit's PA cues — when the
 *  seated group's announcement and the finished race's announcement played
 *  (pit/audio.server.ts). Post's press also writes `pitted`, so those two rows
 *  arriving together is the normal shape of a turnover. */
export type BriefingEventAction =
  | "sent"
  | "started"
  | "restarted"
  | "photo"
  | "ended"
  | "pitted"
  | "audio-pre"
  | "audio-post";

/** Why a room was released. `film-complete` is never STORED — it is what
 *  briefing-log.ts infers when no explicit end was ever recorded. `holding`
 *  (2026-08-13) is the send-to-holding press: the group left for the pit
 *  seats, which is also the moment the room became free. */
export type BriefingEndReason = "cleared" | "replaced" | "holding";

export interface BriefingEvent {
  id: string;
  venue: string;
  businessDay: string;
  room: BriefingRoom;
  track: string | null;
  sessionId: string;
  heatNumber: number | null;
  raceType: string | null;
  tier: BriefingTier | null;
  action: BriefingEventAction;
  /** ms since epoch — the log is arithmetic, not display, so it travels as a
   *  number and never as a locale-formatted string. */
  atMs: number;
  videoUrl: string | null;
  videoMs: number | null;
  /** The room's camera still for this briefing, on a `photo` row. */
  photoUrl: string | null;
  reason: string | null;
  /** WAIT-TIME ANCHORS, on a `sent` row. When the heat was called, and the two
   *  ends of its check-in window. Null on every other action, and null on a
   *  `sent` row written before this existed or when the source had already aged
   *  out — which the metrics read as "no number for this heat", never as zero. */
  calledAtMs: number | null;
  checkinFirstAtMs: number | null;
  checkinLastAtMs: number | null;
  checkinIn: number | null;
  checkinTotal: number | null;
}

/** A nullable TIMESTAMPTZ as epoch ms. An unparseable stamp is null, never NaN —
 *  NaN would sail through arithmetic and land in an average as garbage. */
function msOrNull(value: unknown): number | null {
  if (value == null) return null;
  const ms = Date.parse(String(value));
  return Number.isFinite(ms) ? ms : null;
}

function toRow(r: Record<string, unknown>): BriefingEvent {
  return {
    id: String(r.id),
    venue: String(r.venue),
    businessDay: String(r.business_day),
    room: String(r.room) as BriefingRoom,
    track: r.track == null ? null : String(r.track),
    sessionId: String(r.session_id),
    heatNumber: r.heat_number == null ? null : Number(r.heat_number),
    raceType: r.race_type == null ? null : String(r.race_type),
    tier: r.tier == null ? null : (String(r.tier) as BriefingTier),
    action: String(r.action) as BriefingEventAction,
    atMs: Date.parse(String(r.at)),
    videoUrl: r.video_url == null ? null : String(r.video_url),
    videoMs: r.video_ms == null ? null : Number(r.video_ms),
    photoUrl: r.photo_url == null ? null : String(r.photo_url),
    reason: r.reason == null ? null : String(r.reason),
    calledAtMs: msOrNull(r.called_at),
    checkinFirstAtMs: msOrNull(r.checkin_first_at),
    checkinLastAtMs: msOrNull(r.checkin_last_at),
    checkinIn: r.checkin_in == null ? null : Number(r.checkin_in),
    checkinTotal: r.checkin_total == null ? null : Number(r.checkin_total),
  };
}

export interface RecordBriefingEventArgs {
  venue: string;
  businessDay: string;
  room: BriefingRoom;
  track: string | null;
  sessionId: string;
  heatNumber: number | null;
  raceType: string | null;
  tier: BriefingTier | null;
  action: BriefingEventAction;
  videoUrl?: string | null;
  videoMs?: number | null;
  photoUrl?: string | null;
  reason?: BriefingEndReason | null;
  /** Wait-time anchors — only ever passed on a `sent` row. */
  calledAtMs?: number | null;
  checkinFirstAtMs?: number | null;
  checkinLastAtMs?: number | null;
  checkinIn?: number | null;
  checkinTotal?: number | null;
}

/**
 * Append one action.
 *
 * AWAITED AND UNCAUGHT AT THE CALL SITES, which is a deliberate posture and the
 * same one `recordBriefingAssignment` already takes: if this write cannot land,
 * the staff action fails loudly rather than proceeding unrecorded. A safety
 * briefing whose record silently did not save is precisely the failure this table
 * exists to prevent — and a Neon that cannot accept an insert is an outage where
 * every other page is already broken.
 */
/** Epoch ms → an ISO string Postgres will take, or null. */
function isoOrNull(ms: number | null | undefined): string | null {
  return ms == null || !Number.isFinite(ms) ? null : new Date(ms).toISOString();
}

export async function recordBriefingEvent(args: RecordBriefingEventArgs): Promise<void> {
  if (!isDbConfigured()) return;
  await ensureSchema();
  const q = sql();
  await q`
    INSERT INTO briefing_events
      (venue, business_day, room, track, session_id, heat_number, race_type, tier,
       action, video_url, video_ms, photo_url, reason,
       called_at, checkin_first_at, checkin_last_at, checkin_in, checkin_total)
    VALUES
      (${args.venue}, ${args.businessDay}, ${args.room}, ${args.track}, ${args.sessionId},
       ${args.heatNumber}, ${args.raceType}, ${args.tier}, ${args.action},
       ${args.videoUrl ?? null}, ${args.videoMs ?? null}, ${args.photoUrl ?? null},
       ${args.reason ?? null},
       ${isoOrNull(args.calledAtMs)}, ${isoOrNull(args.checkinFirstAtMs)},
       ${isoOrNull(args.checkinLastAtMs)}, ${args.checkinIn ?? null},
       ${args.checkinTotal ?? null})
  `;
}

/** A day's actions, OLDEST FIRST — the fold walks them in order. */
export async function listBriefingEvents(
  venue: string,
  businessDay: string,
): Promise<BriefingEvent[]> {
  if (!isDbConfigured()) return [];
  await ensureSchema();
  const q = sql();
  const rows = (await q`
    SELECT id, venue, business_day, room, track, session_id, heat_number, race_type, tier,
           action, at, video_url, video_ms, photo_url, reason,
           called_at, checkin_first_at, checkin_last_at, checkin_in, checkin_total
    FROM briefing_events
    WHERE venue = ${venue} AND business_day = ${businessDay}
    ORDER BY at ASC, id ASC
    LIMIT 500
  `) as Array<Record<string, unknown>>;
  return rows.map(toRow);
}

/**
 * Every action ever recorded for one session, oldest first — the shape an
 * insurance or incident question arrives in ("what happened with heat 24?").
 * Not day-scoped: the session id is unique across days, and a question about a
 * past date must not need the caller to know our business-day arithmetic.
 */
export async function listBriefingEventsForSession(sessionId: string): Promise<BriefingEvent[]> {
  if (!isDbConfigured() || !sessionId) return [];
  await ensureSchema();
  const q = sql();
  const rows = (await q`
    SELECT id, venue, business_day, room, track, session_id, heat_number, race_type, tier,
           action, at, video_url, video_ms, photo_url, reason,
           called_at, checkin_first_at, checkin_last_at, checkin_in, checkin_total
    FROM briefing_events
    WHERE session_id = ${sessionId}
    ORDER BY at ASC, id ASC
    LIMIT 200
  `) as Array<Record<string, unknown>>;
  return rows.map(toRow);
}
