/**
 * `crm_bmi_projects` + `crm_bmi_sync_runs` — the read-only mirror of Office
 * projects (brief §3.8), the substrate for History & Accounts and the KPI
 * board. Every id column is TEXT; `raw` keeps the precision-safe parse of the
 * row as Office returned it (minus the staff log arrays).
 *
 * DDL from PR1; B1 adds `account_id` / `contact_id` (ADD COLUMN IF NOT EXISTS,
 * the only DDL a later PR may do, §3.8), the upsert, the sync-run ledger and
 * the readers behind `/history`, `/accounts/[id]` and `/last-year`.
 *
 * WRITES ARE IDEMPOTENT: `upsertMirrorRow` is `INSERT … ON CONFLICT
 * (project_id) DO UPDATE` and reports whether the row was new (`xmax = 0`) so
 * a second backfill of the same window proves itself with "0 inserted".
 * Account / contact links and person fields are COALESCEd on conflict, so a
 * later partial read never blanks a link an earlier full read made.
 *
 * READS: keyset pagination on `(event_date DESC, project_id DESC)` with an
 * opaque cursor, `limit ≤ 200` (R10). Online bookings (`kind_id = '-10'`) are
 * KEPT in the table and hidden by the readers — the KPI board wants them gone,
 * the raw mirror does not lie about what Office holds.
 */

import { isDbConfigured, sql } from "@ft/db";
import type { MirrorRow, MirrorSource } from "../service/projection";

let schemaReady: Promise<void> | null = null;

export function ensureBmiProjectsSchema(): Promise<void> {
  schemaReady ??= (async () => {
    const q = sql();
    await q`
      CREATE TABLE IF NOT EXISTS crm_bmi_projects (
        project_id TEXT PRIMARY KEY,
        client_key TEXT NOT NULL,
        location_id INTEGER,
        number TEXT,
        name TEXT,
        state_id TEXT,
        state_name TEXT,
        kind_id TEXT,
        responsible_user_id TEXT,
        responsible_name TEXT,
        event_date DATE,
        event_start TIMESTAMPTZ,
        persons INTEGER,
        total_value_cents BIGINT,
        balance_cents BIGINT,
        person_id TEXT,
        person_name TEXT,
        person_phone TEXT,
        person_email TEXT,
        products JSONB,
        raw JSONB,
        source TEXT NOT NULL CHECK (source IN ('backfill','delta','detail')),
        bmi_created_at TIMESTAMPTZ,
        bmi_updated_at TIMESTAMPTZ,
        synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
    await q`CREATE INDEX IF NOT EXISTS crm_bmi_projects_date ON crm_bmi_projects (client_key, event_date)`;
    await q`CREATE INDEX IF NOT EXISTS crm_bmi_projects_resp ON crm_bmi_projects (responsible_user_id, event_date)`;
    await q`CREATE INDEX IF NOT EXISTS crm_bmi_projects_phone ON crm_bmi_projects (person_phone)`;
    // B1: the account / contact the mirror matched this project to.
    await q`ALTER TABLE crm_bmi_projects ADD COLUMN IF NOT EXISTS account_id BIGINT`;
    await q`ALTER TABLE crm_bmi_projects ADD COLUMN IF NOT EXISTS contact_id BIGINT`;
    await q`CREATE INDEX IF NOT EXISTS crm_bmi_projects_account ON crm_bmi_projects (account_id, event_date DESC)`;
    await q`CREATE INDEX IF NOT EXISTS crm_bmi_projects_email ON crm_bmi_projects (lower(person_email))`;
    await q`
      CREATE TABLE IF NOT EXISTS crm_bmi_sync_runs (
        id BIGSERIAL PRIMARY KEY,
        client_key TEXT NOT NULL,
        kind TEXT NOT NULL,
        window_from TIMESTAMPTZ,
        window_until TIMESTAMPTZ,
        rows_seen INTEGER,
        rows_upserted INTEGER,
        ok BOOLEAN NOT NULL,
        error TEXT,
        started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        finished_at TIMESTAMPTZ
      )
    `;
    await q`CREATE INDEX IF NOT EXISTS crm_bmi_sync_runs_ck ON crm_bmi_sync_runs (client_key, kind, started_at DESC)`;
  })();
  return schemaReady;
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

/** A `crm_bmi_projects` row as the neon driver returns it (bigints as text). */
export interface MirrorRowRaw {
  project_id: string;
  client_key: string;
  location_id: number | null;
  number: string | null;
  name: string | null;
  state_id: string | null;
  state_name: string | null;
  kind_id: string | null;
  responsible_user_id: string | null;
  responsible_name: string | null;
  event_date: string | null;
  event_start: string | null;
  persons: number | null;
  total_value_cents: string | number | null;
  balance_cents: string | number | null;
  person_id: string | null;
  person_name: string | null;
  person_phone: string | null;
  person_email: string | null;
  products: unknown;
  source: string;
  bmi_created_at: string | null;
  bmi_updated_at: string | null;
  synced_at: string;
  account_id: string | null;
  contact_id: string | null;
}

/** The mirror row as readers see it (no `raw`, links included). */
export interface MirrorProject {
  projectId: string;
  clientKey: string;
  locationId: number | null;
  number: string | null;
  name: string | null;
  stateId: string | null;
  stateName: string | null;
  kindId: string | null;
  responsibleUserId: string | null;
  responsibleName: string | null;
  eventDate: string | null;
  eventStart: string | null;
  persons: number | null;
  totalValueCents: number | null;
  balanceCents: number | null;
  personId: string | null;
  personName: string | null;
  personPhone: string | null;
  personEmail: string | null;
  products: unknown;
  source: MirrorSource;
  bmiCreatedAt: string | null;
  bmiUpdatedAt: string | null;
  syncedAt: string;
  accountId: string | null;
  contactId: string | null;
}

function centsOf(v: string | number | null): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

const SOURCES = new Set<MirrorSource>(["backfill", "delta", "detail"]);

export function mapMirrorRow(r: MirrorRowRaw): MirrorProject {
  return {
    projectId: String(r.project_id),
    clientKey: r.client_key,
    locationId: r.location_id ?? null,
    number: r.number ?? null,
    name: r.name ?? null,
    stateId: r.state_id ?? null,
    stateName: r.state_name ?? null,
    kindId: r.kind_id ?? null,
    responsibleUserId: r.responsible_user_id ?? null,
    responsibleName: r.responsible_name ?? null,
    eventDate: r.event_date ? String(r.event_date).slice(0, 10) : null,
    eventStart: r.event_start ?? null,
    persons: r.persons ?? null,
    totalValueCents: centsOf(r.total_value_cents),
    balanceCents: centsOf(r.balance_cents),
    personId: r.person_id ?? null,
    personName: r.person_name ?? null,
    personPhone: r.person_phone ?? null,
    personEmail: r.person_email ?? null,
    products: r.products ?? null,
    source: SOURCES.has(r.source as MirrorSource) ? (r.source as MirrorSource) : "backfill",
    bmiCreatedAt: r.bmi_created_at ?? null,
    bmiUpdatedAt: r.bmi_updated_at ?? null,
    syncedAt: r.synced_at,
    accountId: r.account_id === null || r.account_id === undefined ? null : String(r.account_id),
    contactId: r.contact_id === null || r.contact_id === undefined ? null : String(r.contact_id),
  };
}

const COLUMNS = `
  p.project_id, p.client_key, p.location_id, p.number, p.name, p.state_id, p.state_name, p.kind_id,
  p.responsible_user_id, p.responsible_name, p.event_date::text AS event_date, p.event_start::text AS event_start,
  p.persons, p.total_value_cents::text AS total_value_cents, p.balance_cents::text AS balance_cents,
  p.person_id, p.person_name, p.person_phone, p.person_email, p.products, p.source,
  p.bmi_created_at::text AS bmi_created_at, p.bmi_updated_at::text AS bmi_updated_at, p.synced_at::text AS synced_at,
  p.account_id::text AS account_id, p.contact_id::text AS contact_id
`;

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export interface MirrorLink {
  accountId: string | null;
  contactId: string | null;
}

/** Upsert one row; `inserted` is true when the project was new to the mirror. */
export async function upsertMirrorRow(
  row: MirrorRow,
  link: MirrorLink = { accountId: null, contactId: null },
): Promise<{ inserted: boolean }> {
  if (!isDbConfigured()) throw new Error("DATABASE_URL is not set");
  await ensureBmiProjectsSchema();
  const q = sql();
  const rows = (await q.query(
    `INSERT INTO crm_bmi_projects (
       project_id, client_key, location_id, number, name, state_id, state_name, kind_id,
       responsible_user_id, responsible_name, event_date, event_start, persons,
       total_value_cents, balance_cents, person_id, person_name, person_phone, person_email,
       products, raw, source, bmi_created_at, bmi_updated_at, account_id, contact_id, synced_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8,
       $9, $10, $11::date, $12::timestamptz, $13,
       $14, $15, $16, $17, $18, $19,
       $20::jsonb, $21::jsonb, $22, $23::timestamptz, $24::timestamptz, $25::bigint, $26::bigint, NOW()
     )
     ON CONFLICT (project_id) DO UPDATE SET
       client_key = EXCLUDED.client_key,
       location_id = COALESCE(EXCLUDED.location_id, crm_bmi_projects.location_id),
       number = COALESCE(EXCLUDED.number, crm_bmi_projects.number),
       name = COALESCE(EXCLUDED.name, crm_bmi_projects.name),
       state_id = COALESCE(EXCLUDED.state_id, crm_bmi_projects.state_id),
       state_name = COALESCE(EXCLUDED.state_name, crm_bmi_projects.state_name),
       kind_id = COALESCE(EXCLUDED.kind_id, crm_bmi_projects.kind_id),
       responsible_user_id = COALESCE(EXCLUDED.responsible_user_id, crm_bmi_projects.responsible_user_id),
       responsible_name = COALESCE(EXCLUDED.responsible_name, crm_bmi_projects.responsible_name),
       event_date = COALESCE(EXCLUDED.event_date, crm_bmi_projects.event_date),
       event_start = COALESCE(EXCLUDED.event_start, crm_bmi_projects.event_start),
       persons = COALESCE(EXCLUDED.persons, crm_bmi_projects.persons),
       total_value_cents = COALESCE(EXCLUDED.total_value_cents, crm_bmi_projects.total_value_cents),
       balance_cents = COALESCE(EXCLUDED.balance_cents, crm_bmi_projects.balance_cents),
       person_id = COALESCE(EXCLUDED.person_id, crm_bmi_projects.person_id),
       person_name = COALESCE(EXCLUDED.person_name, crm_bmi_projects.person_name),
       person_phone = COALESCE(EXCLUDED.person_phone, crm_bmi_projects.person_phone),
       person_email = COALESCE(EXCLUDED.person_email, crm_bmi_projects.person_email),
       products = COALESCE(EXCLUDED.products, crm_bmi_projects.products),
       raw = COALESCE(EXCLUDED.raw, crm_bmi_projects.raw),
       source = EXCLUDED.source,
       bmi_created_at = COALESCE(EXCLUDED.bmi_created_at, crm_bmi_projects.bmi_created_at),
       bmi_updated_at = COALESCE(EXCLUDED.bmi_updated_at, crm_bmi_projects.bmi_updated_at),
       account_id = COALESCE(EXCLUDED.account_id, crm_bmi_projects.account_id),
       contact_id = COALESCE(EXCLUDED.contact_id, crm_bmi_projects.contact_id),
       synced_at = NOW()
     RETURNING (xmax = 0) AS inserted`,
    [
      row.projectId,
      row.clientKey,
      row.locationId,
      row.number,
      row.name,
      row.stateId,
      row.stateName,
      row.kindId,
      row.responsibleUserId,
      row.responsibleName,
      row.eventDate,
      row.eventStart,
      row.persons,
      row.totalValueCents,
      row.balanceCents,
      row.personId,
      row.personName,
      row.personPhone,
      row.personEmail,
      row.products === null ? null : JSON.stringify(row.products),
      row.raw === null ? null : JSON.stringify(row.raw),
      row.source,
      row.bmiCreatedAt,
      row.bmiUpdatedAt,
      link.accountId,
      link.contactId,
    ],
  )) as { inserted: boolean }[];
  return { inserted: rows[0]?.inserted === true };
}

/**
 * Upsert MANY rows in one statement (UNNEST), for the online-booking stubs a
 * dayPlanner window lists by the thousand. Same ON CONFLICT / COALESCE rules
 * as `upsertMirrorRow`; links are null (a stub has no host contact). Returns
 * how many were new. Chunks of 500 keep each statement's parameters modest.
 *
 * EVERY column comes from an UNNEST array, `synced_at` included ($19): the
 * statement is a plain `INSERT … SELECT * FROM UNNEST(...)` with as many
 * arrays as columns, nothing clever. (It used to lean on an implicit
 * cross-join with `NOW()` to supply the 19th column — correct, but a shape no
 * reader could check at a glance and no SQL-text test could prove.)
 */
export async function upsertMirrorRowsBulk(
  rows: readonly MirrorRow[],
): Promise<{ inserted: number; written: number }> {
  if (rows.length === 0) return { inserted: 0, written: 0 };
  if (!isDbConfigured()) throw new Error("DATABASE_URL is not set");
  await ensureBmiProjectsSchema();
  const q = sql();
  const now = new Date().toISOString();
  let inserted = 0;
  let written = 0;
  for (let i = 0; i < rows.length; i += BULK_CHUNK) {
    const part = rows.slice(i, i + BULK_CHUNK);
    const res = (await q.query(
      `INSERT INTO crm_bmi_projects (
         project_id, client_key, location_id, number, name, state_id, state_name, kind_id,
         responsible_user_id, responsible_name, event_date, event_start, persons,
         person_id, person_name, source, bmi_created_at, bmi_updated_at, synced_at
       )
       SELECT * FROM UNNEST(
         $1::text[], $2::text[], $3::int[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[],
         $9::text[], $10::text[], $11::date[], $12::timestamptz[], $13::int[],
         $14::text[], $15::text[], $16::text[], $17::timestamptz[], $18::timestamptz[], $19::timestamptz[]
       ) AS u(project_id, client_key, location_id, number, name, state_id, state_name, kind_id,
              responsible_user_id, responsible_name, event_date, event_start, persons,
              person_id, person_name, source, bmi_created_at, bmi_updated_at, synced_at)
       ON CONFLICT (project_id) DO UPDATE SET
         client_key = EXCLUDED.client_key,
         location_id = COALESCE(EXCLUDED.location_id, crm_bmi_projects.location_id),
         number = COALESCE(EXCLUDED.number, crm_bmi_projects.number),
         name = COALESCE(EXCLUDED.name, crm_bmi_projects.name),
         state_id = COALESCE(EXCLUDED.state_id, crm_bmi_projects.state_id),
         state_name = COALESCE(EXCLUDED.state_name, crm_bmi_projects.state_name),
         kind_id = COALESCE(EXCLUDED.kind_id, crm_bmi_projects.kind_id),
         responsible_user_id = COALESCE(EXCLUDED.responsible_user_id, crm_bmi_projects.responsible_user_id),
         responsible_name = COALESCE(EXCLUDED.responsible_name, crm_bmi_projects.responsible_name),
         event_date = COALESCE(EXCLUDED.event_date, crm_bmi_projects.event_date),
         event_start = COALESCE(EXCLUDED.event_start, crm_bmi_projects.event_start),
         persons = COALESCE(EXCLUDED.persons, crm_bmi_projects.persons),
         person_id = COALESCE(EXCLUDED.person_id, crm_bmi_projects.person_id),
         person_name = COALESCE(EXCLUDED.person_name, crm_bmi_projects.person_name),
         source = EXCLUDED.source,
         bmi_created_at = COALESCE(EXCLUDED.bmi_created_at, crm_bmi_projects.bmi_created_at),
         bmi_updated_at = COALESCE(EXCLUDED.bmi_updated_at, crm_bmi_projects.bmi_updated_at),
         synced_at = NOW()
       RETURNING (xmax = 0) AS inserted`,
      [
        part.map((r) => r.projectId),
        part.map((r) => r.clientKey),
        part.map((r) => r.locationId),
        part.map((r) => r.number),
        part.map((r) => r.name),
        part.map((r) => r.stateId),
        part.map((r) => r.stateName),
        part.map((r) => r.kindId),
        part.map((r) => r.responsibleUserId),
        part.map((r) => r.responsibleName),
        part.map((r) => r.eventDate),
        part.map((r) => r.eventStart),
        part.map((r) => r.persons),
        part.map((r) => r.personId),
        part.map((r) => r.personName),
        part.map((r) => r.source),
        part.map((r) => r.bmiCreatedAt),
        part.map((r) => r.bmiUpdatedAt),
        part.map(() => now),
      ],
    )) as { inserted: boolean }[];
    written += res.length;
    inserted += res.filter((x) => x.inserted === true).length;
  }
  return { inserted, written };
}

export const BULK_CHUNK = 500;

/** `project_id → kind_id` for the ids the mirror already holds (the delta skips detail reads for online bookings). */
export async function getMirrorKinds(
  projectIds: readonly string[],
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  if (projectIds.length === 0 || !isDbConfigured()) return out;
  await ensureBmiProjectsSchema();
  const q = sql();
  const rows = (await q.query(
    `SELECT project_id, kind_id FROM crm_bmi_projects WHERE project_id = ANY($1::text[])`,
    [[...projectIds]],
  )) as { project_id: string; kind_id: string | null }[];
  for (const r of rows) out.set(String(r.project_id), r.kind_id ?? null);
  return out;
}

// ---------------------------------------------------------------------------
// Sync-run ledger
// ---------------------------------------------------------------------------

export type SyncKind = "backfill" | "delta";

export interface SyncRun {
  id: string;
  clientKey: string;
  kind: SyncKind | string;
  windowFrom: string | null;
  windowUntil: string | null;
  rowsSeen: number | null;
  rowsUpserted: number | null;
  ok: boolean;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface SyncRunRaw {
  id: string;
  client_key: string;
  kind: string;
  window_from: string | null;
  window_until: string | null;
  rows_seen: number | null;
  rows_upserted: number | null;
  ok: boolean;
  error: string | null;
  started_at: string;
  finished_at: string | null;
}

export function mapSyncRun(r: SyncRunRaw): SyncRun {
  return {
    id: String(r.id),
    clientKey: r.client_key,
    kind: r.kind,
    windowFrom: r.window_from ?? null,
    windowUntil: r.window_until ?? null,
    rowsSeen: r.rows_seen ?? null,
    rowsUpserted: r.rows_upserted ?? null,
    ok: r.ok === true,
    error: r.error ?? null,
    startedAt: r.started_at,
    finishedAt: r.finished_at ?? null,
  };
}

const RUN_COLUMNS = `
  id::text AS id, client_key, kind, window_from::text AS window_from, window_until::text AS window_until,
  rows_seen, rows_upserted, ok, error, started_at::text AS started_at, finished_at::text AS finished_at
`;

/** Open a run row (`ok = false` until finished — a crash leaves an honest row). */
export async function startSyncRun(input: {
  clientKey: string;
  kind: SyncKind;
  windowFrom: string | null;
  windowUntil: string | null;
}): Promise<string> {
  if (!isDbConfigured()) throw new Error("DATABASE_URL is not set");
  await ensureBmiProjectsSchema();
  const q = sql();
  const rows = (await q.query(
    `INSERT INTO crm_bmi_sync_runs (client_key, kind, window_from, window_until, ok)
     VALUES ($1, $2, $3::timestamptz, $4::timestamptz, false)
     RETURNING id::text AS id`,
    [input.clientKey, input.kind, input.windowFrom, input.windowUntil],
  )) as { id: string }[];
  return String(rows[0]?.id);
}

export async function finishSyncRun(
  id: string,
  result: { rowsSeen: number; rowsUpserted: number; ok: boolean; error: string | null },
): Promise<SyncRun | null> {
  if (!isDbConfigured()) return null;
  const q = sql();
  const rows = (await q.query(
    `UPDATE crm_bmi_sync_runs
        SET rows_seen = $2, rows_upserted = $3, ok = $4, error = $5, finished_at = NOW()
      WHERE id = $1::bigint
      RETURNING ${RUN_COLUMNS}`,
    [
      id,
      result.rowsSeen,
      result.rowsUpserted,
      result.ok,
      result.error ? result.error.slice(0, 2000) : null,
    ],
  )) as SyncRunRaw[];
  return rows[0] ? mapSyncRun(rows[0]) : null;
}

/** The latest successful run of a kind for a tenant — the delta's watermark. */
export async function lastOkSyncRun(clientKey: string, kind: SyncKind): Promise<SyncRun | null> {
  if (!isDbConfigured()) return null;
  await ensureBmiProjectsSchema();
  const q = sql();
  const rows = (await q.query(
    `SELECT ${RUN_COLUMNS} FROM crm_bmi_sync_runs
      WHERE client_key = $1 AND kind = $2 AND ok = true AND finished_at IS NOT NULL
      ORDER BY window_until DESC NULLS LAST, id DESC
      LIMIT 1`,
    [clientKey, kind],
  )) as SyncRunRaw[];
  return rows[0] ? mapSyncRun(rows[0]) : null;
}

export async function listSyncRuns(
  filter: { clientKey?: string; kind?: SyncKind; limit?: number } = {},
): Promise<SyncRun[]> {
  if (!isDbConfigured()) return [];
  await ensureBmiProjectsSchema();
  const q = sql();
  const limit = Math.min(Math.max(filter.limit ?? 20, 1), 200);
  const rows = (await q.query(
    `SELECT ${RUN_COLUMNS} FROM crm_bmi_sync_runs
      WHERE ($1::text IS NULL OR client_key = $1)
        AND ($2::text IS NULL OR kind = $2)
      ORDER BY started_at DESC, id DESC
      LIMIT $3`,
    [filter.clientKey ?? null, filter.kind ?? null, limit],
  )) as SyncRunRaw[];
  return rows.map(mapSyncRun);
}

// ---------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------

export interface MirrorCount {
  total: number;
  /** Rows that are not online bookings (`kind_id <> '-10'`). */
  groupEvents: number;
}

/** How many projects the mirror holds (optionally one tenant, one event-date span). */
export async function countMirrorProjects(
  filter: { clientKey?: string; from?: string; until?: string } = {},
): Promise<MirrorCount> {
  if (!isDbConfigured()) return { total: 0, groupEvents: 0 };
  await ensureBmiProjectsSchema();
  const q = sql();
  const rows = (await q.query(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE kind_id IS DISTINCT FROM '-10')::int AS group_events
       FROM crm_bmi_projects
      WHERE ($1::text IS NULL OR client_key = $1)
        AND ($2::date IS NULL OR event_date >= $2::date)
        AND ($3::date IS NULL OR event_date <= $3::date)`,
    [filter.clientKey ?? null, filter.from ?? null, filter.until ?? null],
  )) as { total: number; group_events: number }[];
  return { total: Number(rows[0]?.total ?? 0), groupEvents: Number(rows[0]?.group_events ?? 0) };
}

/** Opaque keyset cursor over `(event_date DESC, project_id DESC)`. */
export function encodeCursor(row: Pick<MirrorProject, "eventDate" | "projectId">): string {
  return Buffer.from(`${row.eventDate ?? ""}|${row.projectId}`, "utf8").toString("base64url");
}

export function decodeCursor(
  cursor: string | null | undefined,
): { eventDate: string; projectId: string } | null {
  if (!cursor) return null;
  try {
    const text = Buffer.from(cursor, "base64url").toString("utf8");
    const i = text.indexOf("|");
    if (i < 0) return null;
    const eventDate = text.slice(0, i);
    const projectId = text.slice(i + 1);
    if (!projectId) return null;
    return { eventDate: eventDate || "0001-01-01", projectId };
  } catch {
    return null;
  }
}

export interface PageOpts {
  limit?: number;
  cursor?: string | null;
}

function pageLimit(limit: number | undefined, fallback: number): number {
  return Math.min(Math.max(limit ?? fallback, 1), 200);
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

/** Search hint: the digits of a query, for a `person_phone LIKE` match. */
export function phoneDigitsOf(q: string): string {
  const digits = q.replace(/\D/g, "");
  return digits.length >= 4 ? digits : "";
}

/**
 * Events matching `q` by name, business (account name), host name, phone
 * digits or email — newest first. Online bookings hidden.
 */
export async function searchMirrorProjects(
  q: string,
  opts: PageOpts = {},
): Promise<Page<MirrorProject>> {
  if (!isDbConfigured()) return { items: [], nextCursor: null };
  await ensureBmiProjectsSchema();
  const sqlc = sql();
  const limit = pageLimit(opts.limit, 50);
  const term = q.trim();
  const pattern = `%${term.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
  const digits = phoneDigitsOf(term);
  const after = decodeCursor(opts.cursor);
  const rows = (await sqlc.query(
    `SELECT ${COLUMNS}
       FROM crm_bmi_projects p
       LEFT JOIN crm_accounts a ON a.id = p.account_id
      WHERE p.kind_id IS DISTINCT FROM '-10'
        AND (
              p.name ILIKE $1 OR p.person_name ILIKE $1 OR p.number ILIKE $1
           OR lower(p.person_email) LIKE lower($1)
           OR a.name ILIKE $1
           OR ($2::text <> '' AND p.person_phone LIKE '%' || $2 || '%')
        )
        AND ($3::date IS NULL OR (COALESCE(p.event_date, '0001-01-01'::date), p.project_id) < ($3::date, $4::text))
      ORDER BY COALESCE(p.event_date, '0001-01-01'::date) DESC, p.project_id DESC
      LIMIT $5`,
    [pattern, digits, after?.eventDate ?? null, after?.projectId ?? "", limit + 1],
  )) as MirrorRowRaw[];
  const items = rows.slice(0, limit).map(mapMirrorRow);
  const last = items[items.length - 1];
  return { items, nextCursor: rows.length > limit && last ? encodeCursor(last) : null };
}

/** One account's events, newest first (online bookings hidden). */
export async function listMirrorProjectsForAccount(
  accountId: string,
  opts: PageOpts = {},
): Promise<Page<MirrorProject>> {
  if (!isDbConfigured()) return { items: [], nextCursor: null };
  await ensureBmiProjectsSchema();
  const q = sql();
  const limit = pageLimit(opts.limit, 100);
  const after = decodeCursor(opts.cursor);
  const rows = (await q.query(
    `SELECT ${COLUMNS}
       FROM crm_bmi_projects p
      WHERE p.account_id = $1::bigint
        AND p.kind_id IS DISTINCT FROM '-10'
        AND ($2::date IS NULL OR (COALESCE(p.event_date, '0001-01-01'::date), p.project_id) < ($2::date, $3::text))
      ORDER BY COALESCE(p.event_date, '0001-01-01'::date) DESC, p.project_id DESC
      LIMIT $4`,
    [accountId, after?.eventDate ?? null, after?.projectId ?? "", limit + 1],
  )) as MirrorRowRaw[];
  const items = rows.slice(0, limit).map(mapMirrorRow);
  const last = items[items.length - 1];
  return { items, nextCursor: rows.length > limit && last ? encodeCursor(last) : null };
}

/** Mirror rows by project id (for the account of a single event, etc.). */
export async function getMirrorProject(projectId: string): Promise<MirrorProject | null> {
  if (!isDbConfigured()) return null;
  await ensureBmiProjectsSchema();
  const q = sql();
  const rows = (await q.query(`SELECT ${COLUMNS} FROM crm_bmi_projects p WHERE p.project_id = $1`, [
    projectId,
  ])) as MirrorRowRaw[];
  return rows[0] ? mapMirrorRow(rows[0]) : null;
}

export interface LastYearFilter extends PageOpts {
  /** Inclusive ET calendar days, one year back. */
  from: string;
  till: string;
  clientKey?: string;
}

/**
 * "This time last year": group events in `[from, till]` whose host has NOT
 * come back — no CRM lead and no non-cancelled BMI project for the same
 * account / phone / email in the CURRENT cycle. Cancelled last-year events are
 * not reach-outs. Oldest first, so the soonest anniversary leads.
 *
 * WHAT "COME BACK" MEANS. A later booking only disqualifies a host when it
 * lands in this year's window — `from + 1 year − 8 weeks` onwards, i.e. from
 * roughly five weeks ago. A host who booked again a fortnight after last
 * year's event and has not been seen since is exactly who the reach-out is
 * for; hiding them because they have "any later booking at all" silently drops
 * the best repeat customers. `n.event_date > p.event_date` stays as well, so
 * two events inside the window collapse to the latest.
 *
 * `crm_leads` / `crm_contacts` are read here by SQL only (no import of the
 * leads sub — `leads → bmi` is the declared direction, §3.2); both tables are
 * created by PR1's schema and this reader tolerates their absence via the
 * `to_regclass` guard.
 */
export async function listLastYearHosts(filter: LastYearFilter): Promise<Page<MirrorProject>> {
  if (!isDbConfigured()) return { items: [], nextCursor: null };
  await ensureBmiProjectsSchema();
  const q = sql();
  const limit = pageLimit(filter.limit, 50);
  const after = decodeAscCursor(filter.cursor);
  const rows = (await q.query(
    `SELECT ${COLUMNS}
       FROM crm_bmi_projects p
      WHERE p.event_date BETWEEN $1::date AND $2::date
        AND p.kind_id IS DISTINCT FROM '-10'
        AND p.state_id IS DISTINCT FROM '-4'
        AND ($3::text IS NULL OR p.client_key = $3)
        AND NOT EXISTS (
              SELECT 1 FROM crm_bmi_projects n
               WHERE n.project_id <> p.project_id
                 AND n.event_date > p.event_date
                 AND n.event_date >= $1::date + INTERVAL '1 year' - INTERVAL '8 weeks'
                 AND n.kind_id IS DISTINCT FROM '-10'
                 AND n.state_id IS DISTINCT FROM '-4'
                 AND (
                       (p.account_id IS NOT NULL AND n.account_id = p.account_id)
                    OR (p.person_phone IS NOT NULL AND n.person_phone = p.person_phone)
                    OR (p.person_email IS NOT NULL AND lower(n.person_email) = lower(p.person_email))
                 )
        )
        AND (
              to_regclass('crm_leads') IS NULL
           OR NOT EXISTS (
                SELECT 1 FROM crm_leads l
                LEFT JOIN crm_contacts c ON c.id = l.contact_id
                WHERE l.archived_at IS NULL
                  AND l.event_date > p.event_date
                  AND l.event_date >= $1::date + INTERVAL '1 year' - INTERVAL '8 weeks'
                  AND (
                        (p.account_id IS NOT NULL AND l.account_id = p.account_id)
                     OR (p.person_phone IS NOT NULL AND c.phone_e164 = p.person_phone)
                     OR (p.person_email IS NOT NULL AND c.email_key = lower(p.person_email))
                  )
           )
        )
        AND ($4::date IS NULL OR (p.event_date, p.project_id) > ($4::date, $5::text))
      ORDER BY p.event_date ASC, p.project_id ASC
      LIMIT $6`,
    [
      filter.from,
      filter.till,
      filter.clientKey ?? null,
      after?.eventDate ?? null,
      after?.projectId ?? "",
      limit + 1,
    ],
  )) as MirrorRowRaw[];
  const items = rows.slice(0, limit).map(mapMirrorRow);
  const last = items[items.length - 1];
  return { items, nextCursor: rows.length > limit && last ? encodeCursor(last) : null };
}

/** The ascending cursor shares the encoding; only the comparison differs. */
function decodeAscCursor(cursor: string | null | undefined) {
  return decodeCursor(cursor);
}
