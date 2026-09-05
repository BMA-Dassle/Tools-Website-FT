import "server-only";

/**
 * The permanent record of what happened on track.
 *
 * WHY THIS EXISTS (owner 2026-09-05): our race results keep best times and
 * nothing else, and the venue feed carries far more — every lap, every incident,
 * every flag, ordered to the millisecond. A driver should be able to come back
 * to their laps, and the same rows are what a camera overlay will eventually be
 * cut against. Redis is the hot path; this is the memory.
 *
 * IT IS SMALL, WHICH SETTLES THE "HOW LONG DO WE KEEP IT" QUESTION. Measured
 * from a 32h window of `kart:events:queue` (20,000 entries, 74 sessions): 6,256
 * records worth keeping against 14,207 of churn — SpeedChange, BcTime, RaceAdvice
 * snapshots and ProjectStateChanged, none of which is a fact about a race. That
 * extrapolates to ~4,700 rows and 1.5 MiB of raw JSON a day; ~1.7M rows and about
 * half a gigabyte a year, of which ~619k rows are laps. Normalised into columns
 * it is well under that. So: no TTL, no rollup, no archive tier. Keep it.
 *
 * IDEMPOTENCY IS FREE AND LOAD-BEARING. Every venue record carries its own
 * unique id — `PassingId` on a crossing, `Id` on a notification — so both tables
 * are keyed on it and every insert is `ON CONFLICT DO NOTHING`. This matters more
 * than it looks: the bridge replays its entire catch-up dump on every reconnect
 * (five races re-sent in one burst, observed 2026-08-15), and without a natural
 * key that would duplicate a driver's whole heat each time the socket blinked.
 *
 * IDS ARE TEXT, ALWAYS. `person_id` runs 17 digits for cloud-minted people and a
 * Number round-trip lands on a neighbour while still printing the original —
 * see the bridge's `raw-ids.ts`. BIGINT would survive Postgres but not the JSON
 * on either side of it, so the column is TEXT and nothing casts it.
 *
 * WRITING HERE MUST NEVER COST A RACE. Every function swallows its own errors:
 * an unconfigured database, a missing table, a Neon blip — all of it degrades to
 * "no row written" while the clocks, the boards and the webhook carry on.
 */
import { sql, isDbConfigured } from "@ft/db";
import type { DriverAlert, DriverLap, KartNumber } from "./types";
import type { CrashTrigger } from "./incidents";

let schemaReady = false;

async function ensureSchema(): Promise<boolean> {
  if (schemaReady) return true;
  if (!isDbConfigured()) return false;
  const q = sql();
  await q`
    CREATE TABLE IF NOT EXISTS kart_lap (
      passing_id        TEXT PRIMARY KEY,
      session_id        TEXT,
      session_name      TEXT,
      resource_id       TEXT,
      kart              TEXT        NOT NULL,
      participant_id    TEXT,
      participant_name  TEXT,
      person_id         TEXT,
      lap_time_ms       INTEGER,
      passing_time_utc  TIMESTAMPTZ NOT NULL,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;
  await q`CREATE INDEX IF NOT EXISTS kart_lap_session ON kart_lap(session_id, kart)`;
  await q`CREATE INDEX IF NOT EXISTS kart_lap_person ON kart_lap(person_id) WHERE person_id IS NOT NULL`;
  await q`CREATE INDEX IF NOT EXISTS kart_lap_recent ON kart_lap(kart, passing_time_utc DESC)`;

  await q`
    CREATE TABLE IF NOT EXISTS kart_event (
      event_id        TEXT PRIMARY KEY,
      kind            TEXT        NOT NULL,
      source          TEXT        NOT NULL,
      kart            TEXT,
      participant_id  TEXT,
      person_id       TEXT,
      session_id      TEXT,
      session_name    TEXT,
      resource_id     TEXT,
      note            TEXT,
      value           TEXT,
      occurred_at     TIMESTAMPTZ NOT NULL,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;
  await q`CREATE INDEX IF NOT EXISTS kart_event_kart ON kart_event(kart, occurred_at DESC)`;
  await q`CREATE INDEX IF NOT EXISTS kart_event_session ON kart_event(session_id)`;
  await q`CREATE INDEX IF NOT EXISTS kart_event_kind ON kart_event(kind, occurred_at DESC)`;

  schemaReady = true;
  return true;
}

/** One crossing. Returns whether a row landed, so a script can tell the
 *  difference between "stored" and "silently skipped". */
export async function saveLap(row: {
  passingId: string;
  sessionId: string | null;
  sessionName: string | null;
  resourceId: string | null;
  kart: KartNumber;
  participantId: string | null;
  participantName: string | null;
  personId: string | null;
  lapTimeMs: number | null;
  passingTimeUtc: string;
}): Promise<boolean> {
  try {
    if (!(await ensureSchema())) return false;
    const q = sql();
    await q`
      INSERT INTO kart_lap
        (passing_id, session_id, session_name, resource_id, kart,
         participant_id, participant_name, person_id, lap_time_ms, passing_time_utc)
      VALUES
        (${row.passingId}, ${row.sessionId}, ${row.sessionName}, ${row.resourceId}, ${row.kart},
         ${row.participantId}, ${row.participantName}, ${row.personId}, ${row.lapTimeMs},
         ${row.passingTimeUtc})
      ON CONFLICT (passing_id) DO NOTHING`;
    return true;
  } catch (err) {
    console.error("[driver-view] saveLap failed:", err);
    return false;
  }
}

/** One alert, as the permanent record of a flag or an incident. */
export async function saveEvent(
  alert: DriverAlert,
  extra: { participantId: string | null; personId: string | null; resourceId: string | null },
): Promise<boolean> {
  try {
    if (!(await ensureSchema())) return false;
    const q = sql();
    await q`
      INSERT INTO kart_event
        (event_id, kind, source, kart, participant_id, person_id,
         session_id, session_name, resource_id, note, value, occurred_at)
      VALUES
        (${alert.eventId}, ${alert.kind}, ${alert.source}, ${alert.kart},
         ${extra.participantId}, ${extra.personId}, ${alert.sessionId}, ${alert.sessionName},
         ${extra.resourceId}, ${alert.note}, ${alert.value},
         ${new Date(alert.atMs).toISOString()})
      ON CONFLICT (event_id) DO NOTHING`;
    return true;
  } catch (err) {
    console.error("[driver-view] saveEvent failed:", err);
    return false;
  }
}

/** Every crossing for one kart in one session, oldest first. */
export async function readSessionLaps(
  sessionId: string,
  kart: KartNumber,
): Promise<{ passingId: string; lapTimeMs: number | null; atUtc: string }[]> {
  try {
    if (!(await ensureSchema())) return [];
    const q = sql();
    const rows = (await q`
      SELECT passing_id, lap_time_ms, passing_time_utc
      FROM kart_lap
      WHERE session_id = ${sessionId} AND kart = ${kart}
      ORDER BY passing_time_utc ASC`) as {
      passing_id: string;
      lap_time_ms: number | null;
      passing_time_utc: string | Date;
    }[];
    return rows.map((r) => ({
      passingId: r.passing_id,
      lapTimeMs: r.lap_time_ms,
      atUtc: new Date(r.passing_time_utc).toISOString(),
    }));
  } catch (err) {
    console.error("[driver-view] readSessionLaps failed:", err);
    return [];
  }
}

/**
 * A racer's whole history, newest heat first — what "come back to your laps"
 * actually reads. Keyed on person, so it only answers for a driver we managed to
 * bind to a BMI person; a walk-up who never signed in has laps under their kart
 * and session, reachable by `readSessionLaps`.
 */
export async function readPersonLaps(
  personId: string,
  limit = 200,
): Promise<
  {
    sessionId: string | null;
    sessionName: string | null;
    kart: string;
    lapTimeMs: number | null;
    atUtc: string;
  }[]
> {
  try {
    if (!(await ensureSchema())) return [];
    const q = sql();
    const rows = (await q`
      SELECT session_id, session_name, kart, lap_time_ms, passing_time_utc
      FROM kart_lap
      WHERE person_id = ${personId}
      ORDER BY passing_time_utc DESC
      LIMIT ${limit}`) as {
      session_id: string | null;
      session_name: string | null;
      kart: string;
      lap_time_ms: number | null;
      passing_time_utc: string | Date;
    }[];
    return rows.map((r) => ({
      sessionId: r.session_id,
      sessionName: r.session_name,
      kart: r.kart,
      lapTimeMs: r.lap_time_ms,
      atUtc: new Date(r.passing_time_utc).toISOString(),
    }));
  } catch (err) {
    console.error("[driver-view] readPersonLaps failed:", err);
    return [];
  }
}

/**
 * Every crossing in a session, all karts — what a full result board is built
 * from. One query rather than one per driver: a heat is a few dozen rows.
 */
export async function readSessionCrossings(sessionId: string): Promise<
  {
    kart: string;
    participantId: string | null;
    participantName: string | null;
    personId: string | null;
    sessionName: string | null;
    resourceId: string | null;
    passingId: string;
    lapTimeMs: number | null;
    atUtc: string;
  }[]
> {
  try {
    if (!(await ensureSchema())) return [];
    const q = sql();
    const rows = (await q`
      SELECT kart, participant_id, participant_name, person_id, session_name,
             resource_id, passing_id, lap_time_ms, passing_time_utc
      FROM kart_lap
      WHERE session_id = ${sessionId}
      ORDER BY passing_time_utc ASC`) as {
      kart: string;
      participant_id: string | null;
      participant_name: string | null;
      person_id: string | null;
      session_name: string | null;
      resource_id: string | null;
      passing_id: string;
      lap_time_ms: number | null;
      passing_time_utc: string | Date;
    }[];
    return rows.map((r) => ({
      kart: r.kart,
      participantId: r.participant_id,
      participantName: r.participant_name,
      personId: r.person_id,
      sessionName: r.session_name,
      resourceId: r.resource_id,
      passingId: r.passing_id,
      lapTimeMs: r.lap_time_ms,
      atUtc: new Date(r.passing_time_utc).toISOString(),
    }));
  } catch (err) {
    console.error("[driver-view] readSessionCrossings failed:", err);
    return [];
  }
}

/** Every flag and incident in a session — the report's timeline. */
export async function readSessionEvents(sessionId: string): Promise<
  {
    eventId: string;
    kind: string;
    kart: string | null;
    participantId: string | null;
    note: string | null;
    value: string | null;
    atMs: number;
  }[]
> {
  try {
    if (!(await ensureSchema())) return [];
    const q = sql();
    const rows = (await q`
      SELECT event_id, kind, kart, participant_id, note, value, occurred_at
      FROM kart_event
      WHERE session_id = ${sessionId}
      ORDER BY occurred_at ASC`) as {
      event_id: string;
      kind: string;
      kart: string | null;
      participant_id: string | null;
      note: string | null;
      value: string | null;
      occurred_at: string | Date;
    }[];
    return rows.map((r) => ({
      eventId: r.event_id,
      kind: r.kind,
      kart: r.kart,
      participantId: r.participant_id,
      note: r.note,
      value: r.value,
      atMs: new Date(r.occurred_at).getTime(),
    }));
  } catch (err) {
    console.error("[driver-view] readSessionEvents failed:", err);
    return [];
  }
}

/** The sessions a person has raced, newest first — the /racer entry point. */
export async function readPersonSessions(
  personId: string,
  limit = 25,
): Promise<{ sessionId: string; sessionName: string | null; kart: string; atUtc: string }[]> {
  try {
    if (!(await ensureSchema())) return [];
    const q = sql();
    const rows = (await q`
      SELECT session_id, session_name, kart, MAX(passing_time_utc) AS last_seen
      FROM kart_lap
      WHERE person_id = ${personId} AND session_id IS NOT NULL
      GROUP BY session_id, session_name, kart
      ORDER BY last_seen DESC
      LIMIT ${limit}`) as {
      session_id: string;
      session_name: string | null;
      kart: string;
      last_seen: string | Date;
    }[];
    return rows.map((r) => ({
      sessionId: r.session_id,
      sessionName: r.session_name,
      kart: r.kart,
      atUtc: new Date(r.last_seen).toISOString(),
    }));
  } catch (err) {
    console.error("[driver-view] readPersonSessions failed:", err);
    return [];
  }
}

/**
 * Crash triggers over a window, for the ops incident view.
 *
 * Deliberately returns raw triggers rather than incidents: clustering is pure and
 * lives in `incidents.ts`, so the gap can be re-chosen at read time without a
 * migration. See that file on why "first" is a lead and never a verdict.
 */
export async function readCrashTriggers(sinceMs: number): Promise<CrashTrigger[]> {
  try {
    if (!(await ensureSchema())) return [];
    const q = sql();
    const rows = (await q`
      SELECT event_id, kart, session_id, occurred_at
      FROM kart_event
      WHERE kind IN ('crash', 'caution')
        AND kart IS NOT NULL
        AND occurred_at >= ${new Date(sinceMs).toISOString()}
      ORDER BY occurred_at ASC`) as {
      event_id: string;
      kart: string;
      session_id: string | null;
      occurred_at: string | Date;
    }[];
    return rows.map((r) => ({
      eventId: r.event_id,
      kart: r.kart,
      sessionId: r.session_id,
      atMs: new Date(r.occurred_at).getTime(),
    }));
  } catch (err) {
    console.error("[driver-view] readCrashTriggers failed:", err);
    return [];
  }
}

/** Laps as the view wants them — numbered, ordered, rollout laps kept. */
export type { DriverLap };
