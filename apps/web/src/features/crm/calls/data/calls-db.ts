/**
 * `crm_calls` — 3CX journal rows, reconciled call-log calls and click-to-call
 * intents (brief §3.8). `threecx_call_id` unique where present, so a replayed
 * journal POST and the reconcile job converge on ONE row.
 *
 * DDL BELONGS TO PR1. C3 may only `ADD COLUMN IF NOT EXISTS` inside this, its
 * own sub's data file (brief §4 shared-files table), which is what the second
 * block does: `guest_name`, `call_type` and `raw` are C3's, and they are added
 * to the table PR1 created rather than by editing PR1's `CREATE TABLE`.
 *
 * Ids leave this module as STRINGS (`id::text`) and timestamps as ISO instants
 * in UTC — the CRM wire contract, rendered ET by the client.
 */

import { isDbConfigured, sql } from "@ft/db";
import type { CallRow, CallSource, CallDisposition } from "../contracts";
import type { Direction } from "../../core/types";

let schemaReady: Promise<void> | null = null;

export function ensureCallsSchema(): Promise<void> {
  schemaReady ??= (async () => {
    const q = sql();
    await q`
      CREATE TABLE IF NOT EXISTS crm_calls (
        id BIGSERIAL PRIMARY KEY,
        threecx_call_id TEXT,
        direction TEXT NOT NULL CHECK (direction IN ('in','out')),
        from_e164 TEXT,
        to_e164 TEXT,
        extension TEXT,
        rep_id BIGINT,
        lead_id BIGINT,
        contact_id BIGINT,
        started_at TIMESTAMPTZ,
        answered_at TIMESTAMPTZ,
        ended_at TIMESTAMPTZ,
        duration_seconds INTEGER,
        status TEXT,
        disposition TEXT,
        disposition_note TEXT,
        recording_url TEXT,
        source TEXT NOT NULL CHECK (source IN ('journal','reconcile','manual','click')),
        actor_email TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
    // C3's own columns (ADD COLUMN IF NOT EXISTS only — §3.8).
    await q`ALTER TABLE crm_calls ADD COLUMN IF NOT EXISTS guest_name TEXT`;
    await q`ALTER TABLE crm_calls ADD COLUMN IF NOT EXISTS call_type TEXT`;
    await q`ALTER TABLE crm_calls ADD COLUMN IF NOT EXISTS raw JSONB`;
    await q`ALTER TABLE crm_calls ADD COLUMN IF NOT EXISTS disposed_at TIMESTAMPTZ`;
    await q`ALTER TABLE crm_calls ADD COLUMN IF NOT EXISTS disposed_by TEXT`;
    await q`
      CREATE UNIQUE INDEX IF NOT EXISTS crm_calls_3cx ON crm_calls (threecx_call_id)
      WHERE threecx_call_id IS NOT NULL
    `;
    await q`CREATE INDEX IF NOT EXISTS crm_calls_lead ON crm_calls (lead_id, started_at DESC)`;
    await q`CREATE INDEX IF NOT EXISTS crm_calls_recent ON crm_calls (started_at DESC, id DESC)`;
    await q`CREATE INDEX IF NOT EXISTS crm_calls_rep ON crm_calls (rep_id, started_at DESC)`;
  })();
  return schemaReady;
}

const ISO = (col: string) => `to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

const CALL_SELECT = `
  k.id::text AS id, k.threecx_call_id, k.direction, k.from_e164, k.to_e164, k.extension,
  k.rep_id::text AS rep_id, k.lead_id::text AS lead_id, k.contact_id::text AS contact_id,
  ${ISO("k.started_at")} AS started_at, ${ISO("k.answered_at")} AS answered_at,
  ${ISO("k.ended_at")} AS ended_at, k.duration_seconds, k.status, k.disposition,
  k.disposition_note, k.recording_url, k.source, k.actor_email, k.guest_name, k.call_type,
  ${ISO("k.disposed_at")} AS disposed_at, k.disposed_by,
  ${ISO("k.created_at")} AS created_at,
  l.public_id AS lead_public_id,
  coalesce(a.name, nullif(trim(concat_ws(' ', c.first_name, c.last_name)), '')) AS contact_label,
  r.slug AS rep_slug, r.initials AS rep_initials, r.display_name AS rep_name
`;

const CALL_FROM = `
  FROM crm_calls k
  LEFT JOIN crm_leads l ON l.id = k.lead_id
  LEFT JOIN crm_contacts c ON c.id = k.contact_id
  LEFT JOIN crm_accounts a ON a.id = c.account_id
  LEFT JOIN crm_reps r ON r.id = k.rep_id
`;

/** A joined `crm_calls` row as the neon driver returns it. */
export interface CallRowRaw {
  id: string;
  threecx_call_id: string | null;
  direction: string;
  from_e164: string | null;
  to_e164: string | null;
  extension: string | null;
  rep_id: string | null;
  lead_id: string | null;
  contact_id: string | null;
  started_at: string | null;
  answered_at: string | null;
  ended_at: string | null;
  duration_seconds: number | null;
  status: string | null;
  disposition: string | null;
  disposition_note: string | null;
  recording_url: string | null;
  source: string;
  actor_email: string | null;
  guest_name: string | null;
  call_type: string | null;
  disposed_at: string | null;
  disposed_by: string | null;
  created_at: string;
  lead_public_id: string | null;
  contact_label: string | null;
  rep_slug: string | null;
  rep_initials: string | null;
  rep_name: string | null;
}

const SOURCES = new Set<CallSource>(["journal", "reconcile", "manual", "click"]);

export function mapCallRow(r: CallRowRaw): CallRow {
  return {
    id: String(r.id),
    threecxCallId: r.threecx_call_id ?? null,
    direction: (r.direction === "out" ? "out" : "in") as Direction,
    fromE164: r.from_e164 ?? null,
    toE164: r.to_e164 ?? null,
    extension: r.extension ?? null,
    repId: r.rep_id ?? null,
    repSlug: r.rep_slug ?? null,
    repInitials: r.rep_initials ?? null,
    repName: r.rep_name ?? null,
    leadId: r.lead_id ?? null,
    leadPublicId: r.lead_public_id ?? null,
    contactId: r.contact_id ?? null,
    contactLabel: r.contact_label ?? null,
    guestName: r.guest_name ?? null,
    startedAt: r.started_at ?? null,
    answeredAt: r.answered_at ?? null,
    endedAt: r.ended_at ?? null,
    durationSeconds: typeof r.duration_seconds === "number" ? r.duration_seconds : null,
    status: r.status ?? null,
    callType: r.call_type ?? null,
    disposition: (r.disposition as CallDisposition | null) ?? null,
    dispositionNote: r.disposition_note ?? null,
    disposedAt: r.disposed_at ?? null,
    disposedBy: r.disposed_by ?? null,
    recordingUrl: r.recording_url ?? null,
    source: SOURCES.has(r.source as CallSource) ? (r.source as CallSource) : "manual",
    actorEmail: r.actor_email ?? null,
    createdAt: r.created_at,
  };
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/** Everything a journal / reconcile / click row can carry. */
export interface CallUpsert {
  threecxCallId?: string | null;
  direction: Direction;
  fromE164?: string | null;
  toE164?: string | null;
  extension?: string | null;
  repId?: string | null;
  leadId?: string | null;
  contactId?: string | null;
  startedAt?: Date | string | null;
  answeredAt?: Date | string | null;
  endedAt?: Date | string | null;
  durationSeconds?: number | null;
  status?: string | null;
  callType?: string | null;
  guestName?: string | null;
  recordingUrl?: string | null;
  source: CallSource;
  actorEmail?: string | null;
  raw?: unknown;
}

function iso(v: Date | string | null | undefined): string | null {
  if (!v) return null;
  return v instanceof Date ? v.toISOString() : v;
}

const UPSERT_PARAMS = (c: CallUpsert): unknown[] => [
  c.threecxCallId ?? null,
  c.direction,
  c.fromE164 ?? null,
  c.toE164 ?? null,
  c.extension ?? null,
  c.repId ?? null,
  c.leadId ?? null,
  c.contactId ?? null,
  iso(c.startedAt),
  iso(c.answeredAt),
  iso(c.endedAt),
  c.durationSeconds ?? null,
  c.status ?? null,
  c.callType ?? null,
  c.guestName ?? null,
  c.recordingUrl ?? null,
  c.source,
  c.actorEmail ?? null,
  c.raw === undefined ? null : JSON.stringify(c.raw),
];

const UPSERT_COLUMNS = `threecx_call_id, direction, from_e164, to_e164, extension, rep_id, lead_id,
  contact_id, started_at, answered_at, ended_at, duration_seconds, status, call_type, guest_name,
  recording_url, source, actor_email, raw`;

const UPSERT_VALUES = `$1, $2, $3, $4, $5, $6::bigint, $7::bigint, $8::bigint, $9::timestamptz,
  $10::timestamptz, $11::timestamptz, $12::int, $13, $14, $15, $16, $17, $18, $19::jsonb`;

/**
 * Insert, or MERGE into the row that already carries this `threecx_call_id`.
 *
 * The merge is deliberately one-directional: a later write may FILL a null and
 * may lengthen a call (`duration_seconds`, `ended_at`, `status`,
 * `recording_url`), but it never clears a value and never overwrites a
 * `lead_id` / `contact_id` / `rep_id` a human already set from the tray. That
 * is what makes the journal POST, its own replay and the reconcile job
 * idempotent against each other in any order (brief: "the reconcile job dedupes
 * on the 3CX call id").
 *
 * A row with no `threecx_call_id` (a click-to-call intent) is always an insert
 * — there is nothing to dedupe on yet; reconcile links it later by number.
 */
export async function upsertCall(c: CallUpsert): Promise<CallRow | null> {
  if (!isDbConfigured()) return null;
  await ensureCallsSchema();
  const q = sql();
  const conflict = c.threecxCallId
    ? `ON CONFLICT (threecx_call_id) WHERE threecx_call_id IS NOT NULL DO UPDATE SET
         from_e164 = COALESCE(crm_calls.from_e164, EXCLUDED.from_e164),
         to_e164 = COALESCE(crm_calls.to_e164, EXCLUDED.to_e164),
         extension = COALESCE(crm_calls.extension, EXCLUDED.extension),
         rep_id = COALESCE(crm_calls.rep_id, EXCLUDED.rep_id),
         lead_id = COALESCE(crm_calls.lead_id, EXCLUDED.lead_id),
         contact_id = COALESCE(crm_calls.contact_id, EXCLUDED.contact_id),
         started_at = LEAST(COALESCE(crm_calls.started_at, EXCLUDED.started_at), COALESCE(EXCLUDED.started_at, crm_calls.started_at)),
         answered_at = COALESCE(crm_calls.answered_at, EXCLUDED.answered_at),
         ended_at = GREATEST(COALESCE(crm_calls.ended_at, EXCLUDED.ended_at), COALESCE(EXCLUDED.ended_at, crm_calls.ended_at)),
         duration_seconds = GREATEST(COALESCE(crm_calls.duration_seconds, 0), COALESCE(EXCLUDED.duration_seconds, 0)),
         status = COALESCE(EXCLUDED.status, crm_calls.status),
         call_type = COALESCE(crm_calls.call_type, EXCLUDED.call_type),
         guest_name = COALESCE(crm_calls.guest_name, EXCLUDED.guest_name),
         recording_url = COALESCE(crm_calls.recording_url, EXCLUDED.recording_url),
         raw = COALESCE(EXCLUDED.raw, crm_calls.raw),
         updated_at = NOW()`
    : "";
  const rows = (await q.query(
    `WITH up AS (
       INSERT INTO crm_calls (${UPSERT_COLUMNS})
       VALUES (${UPSERT_VALUES})
       ${conflict}
       RETURNING id
     )
     SELECT ${CALL_SELECT} ${CALL_FROM} WHERE k.id = (SELECT id FROM up)`,
    UPSERT_PARAMS(c),
  )) as CallRowRaw[];
  return rows[0] ? mapCallRow(rows[0]) : null;
}

export async function getCall(id: string): Promise<CallRow | null> {
  if (!isDbConfigured() || !/^\d{1,18}$/.test(id)) return null;
  await ensureCallsSchema();
  const q = sql();
  const rows = (await q.query(`SELECT ${CALL_SELECT} ${CALL_FROM} WHERE k.id = $1::bigint`, [
    id,
  ])) as CallRowRaw[];
  return rows[0] ? mapCallRow(rows[0]) : null;
}

export interface CallDispositionPatch {
  disposition: CallDisposition;
  note: string | null;
  actorEmail: string;
  at?: Date;
}

/** Set the outcome a rep picked. Returns the joined row, or null if it is gone. */
export async function setCallDisposition(
  id: string,
  patch: CallDispositionPatch,
): Promise<CallRow | null> {
  if (!isDbConfigured() || !/^\d{1,18}$/.test(id)) return null;
  await ensureCallsSchema();
  const q = sql();
  const rows = (await q.query(
    `WITH up AS (
       UPDATE crm_calls
          SET disposition = $2, disposition_note = $3, disposed_by = $4,
              disposed_at = COALESCE($5::timestamptz, NOW()), updated_at = NOW()
        WHERE id = $1::bigint
        RETURNING id
     )
     SELECT ${CALL_SELECT} ${CALL_FROM} WHERE k.id = (SELECT id FROM up)`,
    [id, patch.disposition, patch.note, patch.actorEmail, iso(patch.at)],
  )) as CallRowRaw[];
  return rows[0] ? mapCallRow(rows[0]) : null;
}

/** Attach an unknown caller's call to a lead (and that lead's contact and rep). */
export async function linkCall(
  id: string,
  link: { leadId: string; contactId: string | null; repId: string | null },
): Promise<CallRow | null> {
  if (!isDbConfigured() || !/^\d{1,18}$/.test(id)) return null;
  await ensureCallsSchema();
  const q = sql();
  const rows = (await q.query(
    `WITH up AS (
       UPDATE crm_calls
          SET lead_id = $2::bigint,
              contact_id = COALESCE($3::bigint, contact_id),
              rep_id = COALESCE(rep_id, $4::bigint),
              updated_at = NOW()
        WHERE id = $1::bigint
        RETURNING id
     )
     SELECT ${CALL_SELECT} ${CALL_FROM} WHERE k.id = (SELECT id FROM up)`,
    [id, link.leadId, link.contactId, link.repId],
  )) as CallRowRaw[];
  return rows[0] ? mapCallRow(rows[0]) : null;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export const CALL_LIST_MAX = 200;
export const CALL_LIST_DEFAULT = 50;

export interface CallListFilter {
  cursor?: string | null;
  limit?: number;
  /** Only this rep's calls (the rep's own board). */
  repId?: string | null;
  leadId?: string | null;
  direction?: Direction;
  /** Answered calls with no disposition yet. */
  needsDisposition?: boolean;
  /** Calls matched to no lead — the Unknown callers tray. */
  unlinked?: boolean;
  missedOnly?: boolean;
}

export interface CallListPage {
  calls: CallRow[];
  nextCursor: string | null;
}

/** `<startedAtIso>|<id>` ⇄ opaque base64url — the same shape the leads list uses. */
export function encodeCallCursor(startedAt: string | null, id: string): string {
  return Buffer.from(`${startedAt ?? ""}|${id}`, "utf8").toString("base64url");
}

export function decodeCallCursor(
  cursor: string | null | undefined,
): { startedAt: string; id: string } | null {
  if (!cursor) return null;
  try {
    const raw = Buffer.from(cursor, "base64url").toString("utf8");
    const bar = raw.lastIndexOf("|");
    if (bar < 0) return null;
    const startedAt = raw.slice(0, bar);
    const id = raw.slice(bar + 1);
    if (!/^\d{1,18}$/.test(id) || Number.isNaN(Date.parse(startedAt))) return null;
    return { startedAt, id };
  } catch {
    return null;
  }
}

/**
 * Keyset on `(started_at DESC, id DESC)`, `limit ≤ 200` (R10) — never OFFSET.
 * `started_at` can be null on a click-intent row that 3CX never confirmed, so
 * the sort coalesces it to `created_at` and the cursor carries that same value.
 */
export async function listCalls(filter: CallListFilter = {}): Promise<CallListPage> {
  if (!isDbConfigured()) return { calls: [], nextCursor: null };
  await ensureCallsSchema();
  const limit = Math.min(Math.max(filter.limit ?? CALL_LIST_DEFAULT, 1), CALL_LIST_MAX);
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (clause: string, value: unknown) => {
    params.push(value);
    where.push(clause.replace("$?", `$${params.length}`));
  };

  if (filter.repId) add("k.rep_id = $?::bigint", filter.repId);
  if (filter.leadId) add("k.lead_id = $?::bigint", filter.leadId);
  if (filter.direction) add("k.direction = $?", filter.direction);
  if (filter.needsDisposition) {
    where.push("k.disposition IS NULL AND k.status = 'Answered' AND k.lead_id IS NOT NULL");
  }
  if (filter.unlinked) where.push("k.lead_id IS NULL");
  if (filter.missedOnly) where.push("k.status <> 'Answered'");

  const cur = decodeCallCursor(filter.cursor);
  if (cur) {
    params.push(cur.startedAt, cur.id);
    where.push(
      `(COALESCE(k.started_at, k.created_at), k.id) < ($${params.length - 1}::timestamptz, $${params.length}::bigint)`,
    );
  }

  params.push(limit + 1);
  const rows = (await sql().query(
    `SELECT ${CALL_SELECT} ${CALL_FROM}
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY COALESCE(k.started_at, k.created_at) DESC, k.id DESC
      LIMIT $${params.length}`,
    params,
  )) as CallRowRaw[];

  const page = rows.slice(0, limit).map(mapCallRow);
  const last = rows.length > limit ? page[page.length - 1] : null;
  return {
    calls: page,
    nextCursor: last ? encodeCallCursor(last.startedAt ?? last.createdAt, last.id) : null,
  };
}

export interface CallStats {
  today: number;
  reached: number;
  /** Whole seconds; the screen renders m:ss. */
  avgTalkSeconds: number;
  missedUnlinked: number;
  needsDisposition: number;
}

export const EMPTY_CALL_STATS: CallStats = Object.freeze({
  today: 0,
  reached: 0,
  avgTalkSeconds: 0,
  missedUnlinked: 0,
  needsDisposition: 0,
});

/**
 * The three tiles ("Calls today", "Reached", "Avg talk time") plus the two
 * counts the banner and the badge need. `since`/`until` are the ET calendar day
 * converted to UTC by the caller (`easternRangeToUtc`, R10) — never
 * `CURRENT_DATE`, which is the server's day, not Fort Myers'.
 */
export async function callStats(opts: {
  since: Date;
  until: Date;
  repId?: string | null;
}): Promise<CallStats> {
  if (!isDbConfigured()) return EMPTY_CALL_STATS;
  await ensureCallsSchema();
  const rows = (await sql().query(
    `SELECT
       count(*) FILTER (WHERE win)::int AS today,
       count(*) FILTER (WHERE win AND k.status = 'Answered')::int AS reached,
       COALESCE(avg(k.duration_seconds) FILTER (WHERE win AND k.status = 'Answered' AND k.duration_seconds > 0), 0)::int AS avg_talk,
       count(*) FILTER (WHERE k.lead_id IS NULL AND k.status <> 'Answered')::int AS missed_unlinked,
       count(*) FILTER (WHERE k.disposition IS NULL AND k.status = 'Answered' AND k.lead_id IS NOT NULL)::int AS needs_disposition
     FROM (
       SELECT k.*, (COALESCE(k.started_at, k.created_at) >= $1::timestamptz
                AND COALESCE(k.started_at, k.created_at) < $2::timestamptz) AS win
         FROM crm_calls k
        WHERE ($3::bigint IS NULL OR k.rep_id = $3::bigint)
     ) k`,
    [opts.since.toISOString(), opts.until.toISOString(), opts.repId ?? null],
  )) as {
    today: number;
    reached: number;
    avg_talk: number;
    missed_unlinked: number;
    needs_disposition: number;
  }[];
  const r = rows[0];
  if (!r) return EMPTY_CALL_STATS;
  return {
    today: r.today ?? 0,
    reached: r.reached ?? 0,
    avgTalkSeconds: r.avg_talk ?? 0,
    missedUnlinked: r.missed_unlinked ?? 0,
    needsDisposition: r.needs_disposition ?? 0,
  };
}

/** The newest `started_at` we already hold — where an incremental reconcile resumes. */
export async function latestCallStartedAt(): Promise<Date | null> {
  if (!isDbConfigured()) return null;
  await ensureCallsSchema();
  const rows = (await sql()`
    SELECT max(started_at) AS at FROM crm_calls WHERE threecx_call_id IS NOT NULL
  `) as { at: string | Date | null }[];
  const at = rows[0]?.at ?? null;
  return at ? new Date(at) : null;
}
