import "server-only";

/**
 * WHAT HAPPENED ON THE TRACK (Neon). Append-only, insurance-grade.
 *
 * WHY IT EXISTS. The venue timing socket has always carried a full track
 * incident stream — emergency stops, session pauses and resumes, starts and
 * finishes — and every one of it was discarded. Surveyed live 2026-08-16: a real
 * E-stop on Blue during heat 60 pressed at 23:15:02, the session paused 0.56s
 * later, five karts flagged as crashed, the session resumed three minutes on.
 * Nothing recorded that it happened. There was no table to ask.
 *
 * The question this has to answer, possibly years later and possibly to
 * somebody's lawyer: *was the track stopped during heat 60 on 16 August, when,
 * for how long, and is there footage?* `race_timings` cannot hold it — that is
 * one upserted row per race, and a heat can be stopped and restarted repeatedly
 * (heat 60 was, four times in ten minutes). So this is an event log, modelled
 * directly on briefing/events-db.ts, which exists for the same reason.
 *
 * APPEND-ONLY, DELIBERATELY. No row is ever updated or deleted. A log you can
 * rewrite is not evidence — and it also means no write here races another, and
 * a replayed broadcast is simply a claim that fails.
 *
 * THE STAMP IS THE VENUE'S, NEVER OURS. `at` is the `Date` off the wire. Our own
 * receive time is a different fact and would be wrong by the delivery lag, which
 * is exactly the error that makes an incident review look at the wrong minute.
 *
 * ─── session_id vs inferred_session_id, THE POINT OF THIS TABLE ───────────
 *
 * The session lifecycle notifications carry a SessionId. Emergency records do
 * NOT — 0 of 16 on the night this was written; an E-stop belongs to a TRACK. So
 * an emergency's heat is something we work out, not something we were told.
 *
 * Those two facts live in two columns and never in one. It is the same
 * distinction briefing_events draws between `holding` and `auto-holding`: a
 * reader must be able to tell what the wire asserted from what we concluded. An
 * emergency filed under a heat we merely inferred, indistinguishable from one
 * the venue named, would put an assertion in the record that nobody made.
 *
 * NO PEOPLE, same posture as briefing_events and race_timings: a session is the
 * group, and the roster is re-readable from Pandora if a question ever needs
 * individuals.
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
    CREATE TABLE IF NOT EXISTS track_events (
      id                  BIGSERIAL PRIMARY KEY,
      venue               TEXT NOT NULL DEFAULT 'FT',
      business_day        TEXT NOT NULL,
      track               TEXT NOT NULL,
      action              TEXT NOT NULL,
      at                  TIMESTAMPTZ NOT NULL,
      session_id          TEXT,
      inferred_session_id TEXT,
      heat_number         INTEGER,
      heat_name           TEXT,
      cameras_marked      INTEGER,
      source              TEXT NOT NULL DEFAULT 'push',
      recorded_at         TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  // The day view (an incident report for one night) and the single-session
  // lookup a safety question actually arrives as.
  await q`
    CREATE INDEX IF NOT EXISTS track_events_day_idx
      ON track_events (venue, business_day, at)
  `;
  await q`
    CREATE INDEX IF NOT EXISTS track_events_session_idx
      ON track_events (session_id, at)
  `;
  schemaReady = true;
}

/**
 * What happened.
 *
 * `paused` / `resumed` are a DESK pause — staff stopping the race at the
 * console. A pause caused by an E-stop is not recorded here at all; it is part
 * of the `emergency-on` row, because the two are one incident and logging both
 * would double every marker on the track's cameras (owner 2026-08-16: "we pause
 * after estop so don't need both logged"). That makes the presence of a
 * `paused` row meaningful in itself: it means nobody hit the button.
 */
export type TrackEventAction =
  | "session-start"
  | "session-end"
  | "paused"
  | "resumed"
  | "emergency-on"
  | "emergency-off";

/** `push` is the venue's own notification. `sampled` is the once-a-minute
 *  fallback watcher, which only runs when the bridge is not delivering — its
 *  stamp can trail the real moment by up to a minute and must be readable as
 *  such. */
export type TrackEventSource = "push" | "sampled";

export interface TrackEvent {
  id: string;
  venue: string;
  businessDay: string;
  track: string;
  action: TrackEventAction;
  atMs: number;
  /** The session the WIRE named. Null on emergencies, always. */
  sessionId: string | null;
  /** The session WE worked out. Never treat as the wire's claim. */
  inferredSessionId: string | null;
  heatNumber: number | null;
  heatName: string | null;
  camerasMarked: number | null;
  source: TrackEventSource;
}

export interface RecordTrackEventArgs {
  venue?: string;
  track: string;
  action: TrackEventAction;
  atMs: number;
  sessionId?: string | null;
  inferredSessionId?: string | null;
  heatNumber?: number | null;
  heatName?: string | null;
  camerasMarked?: number | null;
  source?: TrackEventSource;
}

function toRow(r: Record<string, unknown>): TrackEvent {
  return {
    id: String(r.id),
    venue: String(r.venue),
    businessDay: String(r.business_day),
    track: String(r.track),
    action: String(r.action) as TrackEventAction,
    atMs: Date.parse(String(r.at)),
    sessionId: r.session_id == null ? null : String(r.session_id),
    inferredSessionId: r.inferred_session_id == null ? null : String(r.inferred_session_id),
    heatNumber: r.heat_number == null ? null : Number(r.heat_number),
    heatName: r.heat_name == null ? null : String(r.heat_name),
    camerasMarked: r.cameras_marked == null ? null : Number(r.cameras_marked),
    source: String(r.source) as TrackEventSource,
  };
}

/**
 * Append one track event.
 *
 * NEVER THROWS, unlike recordBriefingEvent — and the difference is deliberate.
 * That one is awaited uncaught so a staff action fails loudly rather than
 * proceeding unrecorded, because a person is standing there and can retry. This
 * rides an ingest webhook with nobody watching: a Neon blip must not cost the
 * race clocks or the radio call sharing that request. The broadcast also
 * replays itself, so a lost write is usually re-offered anyway.
 *
 * THE BUSINESS DAY IS THE EVENT'S OWN, derived from its venue stamp rather than
 * from "now" — a catch-up dump arriving Sunday morning must file Saturday's
 * incidents under Saturday, the same rule race_timings follows.
 */
export async function recordTrackEvent(args: RecordTrackEventArgs): Promise<void> {
  if (!isDbConfigured() || !args.track || !Number.isFinite(args.atMs)) return;
  try {
    await ensureSchema();
    const q = sql();
    await q`
      INSERT INTO track_events
        (venue, business_day, track, action, at, session_id, inferred_session_id,
         heat_number, heat_name, cameras_marked, source)
      VALUES
        (${args.venue ?? "FT"}, ${businessDayYmdET(new Date(args.atMs))}, ${args.track},
         ${args.action}, ${new Date(args.atMs).toISOString()},
         ${args.sessionId ?? null}, ${args.inferredSessionId ?? null},
         ${args.heatNumber ?? null}, ${args.heatName ?? null},
         ${args.camerasMarked ?? null}, ${args.source ?? "push"})
    `;
  } catch (err) {
    console.error("[track-events] write failed", err);
  }
}

/**
 * Row ceiling for one business day. Sized well past any real night — the
 * briefing log's cap was 500, a Saturday wrote 655, and the truncation was
 * silent for three hours. Track events are far sparser (heat 60's unusually bad
 * ten minutes produced about a dozen), so 5000 is roughly two orders of
 * magnitude of headroom, and it says so loudly if it is ever reached.
 */
const DAY_EVENT_CAP = 5000;

/** A day's track events, oldest first — the shape an incident report reads. */
export async function listTrackEvents(venue: string, businessDay: string): Promise<TrackEvent[]> {
  if (!isDbConfigured()) return [];
  await ensureSchema();
  const q = sql();
  const rows = (await q`
    SELECT id, venue, business_day, track, action, at, session_id, inferred_session_id,
           heat_number, heat_name, cameras_marked, source
    FROM track_events
    WHERE venue = ${venue} AND business_day = ${businessDay}
    ORDER BY at ASC, id ASC
    LIMIT ${DAY_EVENT_CAP}
  `) as Array<Record<string, unknown>>;
  if (rows.length >= DAY_EVENT_CAP) {
    console.error(
      `[track-events] DAY CAP HIT: ${rows.length} events for ${venue} ${businessDay} — ` +
        `the log is TRUNCATED and later incidents are missing. Raise DAY_EVENT_CAP.`,
    );
  }
  return rows.map(toRow);
}

/**
 * Everything recorded for one session, oldest first — "what happened during
 * heat 60?".
 *
 * MATCHES EITHER COLUMN. An emergency filed against this session by inference
 * is part of its story and must not be invisible to the question; the returned
 * row still says which column matched, so the caller can weigh it.
 */
export async function listTrackEventsForSession(sessionId: string): Promise<TrackEvent[]> {
  if (!isDbConfigured() || !sessionId) return [];
  await ensureSchema();
  const q = sql();
  const rows = (await q`
    SELECT id, venue, business_day, track, action, at, session_id, inferred_session_id,
           heat_number, heat_name, cameras_marked, source
    FROM track_events
    WHERE session_id = ${sessionId} OR inferred_session_id = ${sessionId}
    ORDER BY at ASC, id ASC
    LIMIT 200
  `) as Array<Record<string, unknown>>;
  return rows.map(toRow);
}
