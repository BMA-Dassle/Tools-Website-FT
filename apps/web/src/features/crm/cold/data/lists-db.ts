/**
 * `crm_cold_lists` — an imported prospect list and who owns it (brief §3.8).
 *
 * DDL BELONGS TO PR1. C8 may only `ADD COLUMN IF NOT EXISTS` inside its own
 * sub's data file (brief §3.8 / §4 shared-files table), which is what the
 * second block does: `status`, `centre`, `headers`, `parse_meta` and
 * `updated_at` are C8's, added to the table PR1 created rather than by editing
 * PR1's `CREATE TABLE`. The table COUNT in `core/schema.ts` is unchanged.
 *
 * Ids leave this module as STRINGS and timestamps as ISO instants in UTC — the
 * CRM wire contract, rendered ET by the client.
 */

import { isDbConfigured, sql } from "@ft/db";
import { ensureRepsSchema } from "~/features/crm/reps";
import type { CentreCode } from "../../core/types";
import {
  EMPTY_COLD_STATS,
  type ColdColumnMap,
  type ColdListStats,
  type ColdListStatus,
  type ColdListView,
  type ColdParseMeta,
} from "../contracts";

let schemaReady: Promise<void> | null = null;

export function ensureColdListsSchema(): Promise<void> {
  schemaReady ??= (async () => {
    await ensureRepsSchema();
    const q = sql();
    await q`
      CREATE TABLE IF NOT EXISTS crm_cold_lists (
        id BIGSERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        owner_rep_id BIGINT REFERENCES crm_reps(id),
        source_filename TEXT,
        column_map JSONB,
        row_count INTEGER NOT NULL DEFAULT 0,
        imported_by TEXT,
        archived_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
    // C8's own columns (ADD COLUMN IF NOT EXISTS only — §3.8).
    await q`ALTER TABLE crm_cold_lists ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'ready'`;
    await q`ALTER TABLE crm_cold_lists ADD COLUMN IF NOT EXISTS centre TEXT`;
    await q`ALTER TABLE crm_cold_lists ADD COLUMN IF NOT EXISTS headers JSONB`;
    await q`ALTER TABLE crm_cold_lists ADD COLUMN IF NOT EXISTS parse_meta JSONB`;
    await q`ALTER TABLE crm_cold_lists ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`;
    await q`CREATE INDEX IF NOT EXISTS crm_cold_lists_live ON crm_cold_lists (created_at DESC) WHERE archived_at IS NULL`;
  })();
  return schemaReady;
}

const ISO = (col: string) => `to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

const LIST_SELECT = `
  cl.id::text AS id, cl.name, cl.status, cl.centre, cl.owner_rep_id::text AS owner_rep_id,
  cl.source_filename, cl.column_map, cl.parse_meta, cl.headers, cl.row_count, cl.imported_by,
  ${ISO("cl.archived_at")} AS archived_at, ${ISO("cl.created_at")} AS created_at,
  r.slug AS owner_slug, r.display_name AS owner_name, r.initials AS owner_initials
`;

const LIST_FROM = `FROM crm_cold_lists cl LEFT JOIN crm_reps r ON r.id = cl.owner_rep_id`;

export interface ColdListRowRaw {
  id: string;
  name: string;
  status: string | null;
  centre: string | null;
  owner_rep_id: string | null;
  source_filename: string | null;
  column_map: unknown;
  parse_meta: unknown;
  headers: unknown;
  row_count: number | string | null;
  imported_by: string | null;
  archived_at: string | null;
  created_at: string;
  owner_slug: string | null;
  owner_name: string | null;
  owner_initials: string | null;
}

function asObject<T>(v: unknown): T | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as T) : null;
}

function asStrings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

const STATUSES = new Set<ColdListStatus>(["staged", "ready"]);

export function mapColdListRow(r: ColdListRowRaw, stats: ColdListStats): ColdListView {
  const status = (r.status ?? "ready") as ColdListStatus;
  return {
    id: String(r.id),
    name: r.name,
    status: STATUSES.has(status) ? status : "ready",
    centre: (r.centre as CentreCode | null) ?? null,
    ownerRepId: r.owner_rep_id ?? null,
    ownerRepSlug: r.owner_slug ?? null,
    ownerRepName: r.owner_name ?? null,
    ownerRepInitials: r.owner_initials ?? null,
    sourceFilename: r.source_filename ?? null,
    columnMap: asObject<ColdColumnMap>(r.column_map),
    parseMeta: asObject<ColdParseMeta>(r.parse_meta),
    headers: asStrings(r.headers),
    rowCount: Number(r.row_count ?? 0) || 0,
    importedBy: r.imported_by ?? null,
    archivedAt: r.archived_at ?? null,
    createdAt: r.created_at,
    stats,
  };
}

// ---------------------------------------------------------------------------
// Per-list counters
// ---------------------------------------------------------------------------

interface StatsRowRaw {
  list_id: string;
  rows: number;
  skipped: number;
  called: number;
  interested: number;
  converted: number;
  booked: number;
  linked: number;
  dialable: number;
  callbacks_due: number;
}

/**
 * The conversion counters, per list, in ONE query.
 *
 * `booked` joins the lead's status through `crm_statuses.kind = 'won'` rather
 * than naming a status id, so a director renaming or adding a won status on
 * the Statuses screen does not silently zero this column.
 */
export async function coldListStats(
  listIds: readonly string[],
): Promise<Map<string, ColdListStats>> {
  const out = new Map<string, ColdListStats>();
  if (!isDbConfigured() || listIds.length === 0) return out;
  await ensureColdListsSchema();
  const q = sql();
  const holes = listIds.map((_, i) => `$${i + 1}::bigint`).join(", ");
  const rows = (await q.query(
    `SELECT cr.list_id::text AS list_id,
            count(*) FILTER (WHERE cr.status <> 'skipped')::int AS rows,
            count(*) FILTER (WHERE cr.status = 'skipped')::int AS skipped,
            count(*) FILTER (WHERE cr.status <> 'skipped' AND cr.disposition IS NOT NULL)::int AS called,
            count(*) FILTER (WHERE cr.status <> 'skipped' AND cr.disposition = 'Interested')::int AS interested,
            count(*) FILTER (WHERE cr.status <> 'skipped' AND cr.lead_id IS NOT NULL)::int AS converted,
            count(*) FILTER (WHERE cr.status <> 'skipped' AND s.kind = 'won')::int AS booked,
            count(*) FILTER (WHERE cr.status <> 'skipped' AND (cr.account_id IS NOT NULL OR cr.contact_id IS NOT NULL))::int AS linked,
            count(*) FILTER (WHERE cr.status <> 'skipped' AND cr.phone_e164 IS NOT NULL)::int AS dialable,
            count(*) FILTER (WHERE cr.status <> 'skipped' AND cr.callback_at IS NOT NULL AND cr.callback_at <= NOW())::int AS callbacks_due
       FROM crm_cold_rows cr
       LEFT JOIN crm_leads l ON l.id = cr.lead_id
       LEFT JOIN crm_statuses s ON s.id = l.status_id
      WHERE cr.list_id IN (${holes})
      GROUP BY cr.list_id`,
    [...listIds],
  )) as StatsRowRaw[];
  for (const r of rows) {
    out.set(String(r.list_id), {
      rows: Number(r.rows) || 0,
      skipped: Number(r.skipped) || 0,
      called: Number(r.called) || 0,
      interested: Number(r.interested) || 0,
      converted: Number(r.converted) || 0,
      booked: Number(r.booked) || 0,
      linked: Number(r.linked) || 0,
      dialable: Number(r.dialable) || 0,
      callbacksDue: Number(r.callbacks_due) || 0,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------

export interface ColdListFilter {
  includeArchived?: boolean;
  ownerRepId?: string | null;
}

export async function listColdLists(filter: ColdListFilter = {}): Promise<ColdListView[]> {
  if (!isDbConfigured()) return [];
  await ensureColdListsSchema();
  const q = sql();
  const where: string[] = [];
  const params: unknown[] = [];
  if (!filter.includeArchived) where.push("cl.archived_at IS NULL");
  if (filter.ownerRepId) {
    params.push(filter.ownerRepId);
    where.push(`cl.owner_rep_id = $${params.length}::bigint`);
  }
  const rows = (await q.query(
    `SELECT ${LIST_SELECT} ${LIST_FROM}
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY cl.created_at DESC, cl.id DESC
      LIMIT 200`,
    params,
  )) as ColdListRowRaw[];
  const stats = await coldListStats(rows.map((r) => String(r.id)));
  return rows.map((r) => mapColdListRow(r, stats.get(String(r.id)) ?? { ...EMPTY_COLD_STATS }));
}

export async function getColdList(id: string): Promise<ColdListView | null> {
  if (!isDbConfigured()) return null;
  await ensureColdListsSchema();
  const q = sql();
  const rows = (await q.query(`SELECT ${LIST_SELECT} ${LIST_FROM} WHERE cl.id = $1::bigint`, [
    id,
  ])) as ColdListRowRaw[];
  if (!rows[0]) return null;
  const stats = await coldListStats([String(rows[0].id)]);
  return mapColdListRow(rows[0], stats.get(String(rows[0].id)) ?? { ...EMPTY_COLD_STATS });
}

// ---------------------------------------------------------------------------
// Writers
// ---------------------------------------------------------------------------

export interface NewColdList {
  name: string;
  ownerRepId: string | null;
  centre: CentreCode | null;
  sourceFilename: string | null;
  headers: string[];
  parseMeta: ColdParseMeta | null;
  columnMap: ColdColumnMap | null;
  importedBy: string;
}

/**
 * The list row exists BEFORE a single record is posted (R2 — persist first).
 * It starts `status='staged'`: the rows are landing, the mapping has not been
 * committed, and the lists screen says so rather than pretending the import
 * finished.
 */
export async function insertColdList(input: NewColdList): Promise<string> {
  if (!isDbConfigured()) throw new Error("DATABASE_URL is not set");
  await ensureColdListsSchema();
  const q = sql();
  const rows = (await q.query(
    `INSERT INTO crm_cold_lists
       (name, owner_rep_id, centre, source_filename, headers, parse_meta, column_map, imported_by, status, row_count)
     VALUES ($1, $2::bigint, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8, 'staged', 0)
     RETURNING id::text AS id`,
    [
      input.name,
      input.ownerRepId,
      input.centre,
      input.sourceFilename,
      JSON.stringify(input.headers ?? []),
      input.parseMeta ? JSON.stringify(input.parseMeta) : null,
      input.columnMap ? JSON.stringify(input.columnMap) : null,
      input.importedBy,
    ],
  )) as { id: string }[];
  const id = rows[0]?.id;
  if (!id) throw new Error("crm_cold_lists: insert returned no id");
  return String(id);
}

export interface ColdListPatch {
  name?: string;
  ownerRepId?: string | null;
  centre?: CentreCode | null;
  columnMap?: ColdColumnMap | null;
  status?: ColdListStatus;
  archived?: boolean;
}

export async function updateColdList(
  id: string,
  patch: ColdListPatch,
): Promise<ColdListView | null> {
  if (!isDbConfigured()) return null;
  await ensureColdListsSchema();
  const q = sql();
  const sets: string[] = ["updated_at = NOW()"];
  const params: unknown[] = [id];
  const add = (frag: string, value: unknown) => {
    params.push(value);
    sets.push(frag.replace("$n", `$${params.length}`));
  };
  if (patch.name !== undefined) add("name = $n", patch.name);
  if (patch.ownerRepId !== undefined) add("owner_rep_id = $n::bigint", patch.ownerRepId);
  if (patch.centre !== undefined) add("centre = $n", patch.centre);
  if (patch.columnMap !== undefined) {
    add("column_map = $n::jsonb", patch.columnMap ? JSON.stringify(patch.columnMap) : null);
  }
  if (patch.status !== undefined) add("status = $n", patch.status);
  if (patch.archived !== undefined) {
    sets.push(patch.archived ? "archived_at = NOW()" : "archived_at = NULL");
  }
  await q.query(`UPDATE crm_cold_lists SET ${sets.join(", ")} WHERE id = $1::bigint`, params);
  return getColdList(id);
}

/** Keep `row_count` honest after an append or a skip decision. */
export async function refreshColdRowCount(listId: string): Promise<number> {
  if (!isDbConfigured()) return 0;
  await ensureColdListsSchema();
  const q = sql();
  const rows = (await q.query(
    `UPDATE crm_cold_lists cl
        SET row_count = (SELECT count(*) FROM crm_cold_rows cr WHERE cr.list_id = cl.id AND cr.status <> 'skipped'),
            updated_at = NOW()
      WHERE cl.id = $1::bigint
      RETURNING row_count`,
    [listId],
  )) as { row_count: number | string }[];
  return Number(rows[0]?.row_count ?? 0) || 0;
}
