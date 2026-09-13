/**
 * `crm_statuses` — OUR pipeline vocabulary (brief §3.8). Ten seeded rows
 * (`crm-data.js:44-55`); a director may add, rename, reorder or archive.
 *
 * `archived_at` is added to the brief's DDL: the conventions say soft-delete
 * via `archived_at` and the wire type `CrmStatus` carries `archivedAt`, so the
 * column has to exist for the two to agree. An archived status keeps its row
 * (leads still reference it) and drops off the board.
 *
 * The BMI side of a status lives in `./status-map-db.ts`.
 */

import { isDbConfigured, sql } from "@ft/db";
import type { CrmStatus, CrmStatusInput, StatusKind } from "../../core/types";

let schemaReady: Promise<void> | null = null;

export function ensureStatusesSchema(): Promise<void> {
  schemaReady ??= (async () => {
    const q = sql();
    await q`
      CREATE TABLE IF NOT EXISTS crm_statuses (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('open','won','lost')),
        position INTEGER NOT NULL,
        sla_label TEXT,
        sla_hours INTEGER,
        on_board BOOLEAN NOT NULL DEFAULT TRUE,
        archived_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
    await q`ALTER TABLE crm_statuses ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ`;
  })();
  return schemaReady;
}

export interface StatusRowRaw {
  id: string;
  label: string;
  kind: string;
  position: number;
  sla_label: string | null;
  sla_hours: number | null;
  on_board: boolean;
  archived_at: string | null;
}

const KINDS = new Set<StatusKind>(["open", "won", "lost"]);

export function mapStatusRow(r: StatusRowRaw): CrmStatus {
  return {
    id: r.id,
    label: r.label,
    kind: KINDS.has(r.kind as StatusKind) ? (r.kind as StatusKind) : "open",
    position: typeof r.position === "number" ? r.position : Number(r.position) || 0,
    slaLabel: r.sla_label ?? null,
    slaHours: r.sla_hours ?? null,
    onBoard: r.on_board !== false,
    archivedAt: r.archived_at ?? null,
  };
}

const COLUMNS = `id, label, kind, position, sla_label, sla_hours, on_board, archived_at::text AS archived_at`;

export async function listStatuses(opts: { includeArchived?: boolean } = {}): Promise<CrmStatus[]> {
  if (!isDbConfigured()) return [];
  await ensureStatusesSchema();
  const q = sql();
  const rows = (await q.query(
    `SELECT ${COLUMNS} FROM crm_statuses
      WHERE ($1::boolean OR archived_at IS NULL)
      ORDER BY position ASC, id ASC`,
    [opts.includeArchived === true],
  )) as StatusRowRaw[];
  return rows.map(mapStatusRow);
}

export async function getStatus(id: string): Promise<CrmStatus | null> {
  if (!isDbConfigured()) return null;
  await ensureStatusesSchema();
  const q = sql();
  const rows = (await q.query(`SELECT ${COLUMNS} FROM crm_statuses WHERE id = $1`, [
    id,
  ])) as StatusRowRaw[];
  return rows[0] ? mapStatusRow(rows[0]) : null;
}

/** The status id shape: lowercase slug, 2–32 chars. */
export const STATUS_ID_RE = /^[a-z][a-z0-9_-]{1,31}$/;

/**
 * Insert or update. A new row without a `position` lands after the last one;
 * an existing row keeps its position unless one is given. Un-archives on upsert
 * so "bring back Waiting on guest" is the same action as editing it.
 */
export async function upsertStatus(input: CrmStatusInput): Promise<CrmStatus> {
  if (!isDbConfigured()) throw new Error("DATABASE_URL is not set");
  await ensureStatusesSchema();
  const q = sql();
  const rows = (await q.query(
    `INSERT INTO crm_statuses (id, label, kind, position, sla_label, sla_hours, on_board)
     VALUES (
       $1, $2, $3,
       COALESCE($4::int, (SELECT COALESCE(MAX(position), 0) + 1 FROM crm_statuses)),
       $5, $6, COALESCE($7::boolean, TRUE)
     )
     ON CONFLICT (id) DO UPDATE SET
       label = EXCLUDED.label,
       kind = EXCLUDED.kind,
       position = COALESCE($4::int, crm_statuses.position),
       sla_label = EXCLUDED.sla_label,
       sla_hours = EXCLUDED.sla_hours,
       on_board = COALESCE($7::boolean, crm_statuses.on_board),
       archived_at = NULL,
       updated_at = NOW()
     RETURNING ${COLUMNS}`,
    [
      input.id,
      input.label,
      input.kind,
      input.position ?? null,
      input.slaLabel ?? null,
      input.slaHours ?? null,
      input.onBoard ?? null,
    ],
  )) as StatusRowRaw[];
  return mapStatusRow(rows[0]);
}

/** Positions 1..n in the order given; ids not listed keep theirs. */
export async function reorderStatuses(ids: readonly string[]): Promise<void> {
  if (!isDbConfigured() || ids.length === 0) return;
  await ensureStatusesSchema();
  const q = sql();
  await q.query(
    `UPDATE crm_statuses AS s
        SET position = o.pos, updated_at = NOW()
       FROM unnest($1::text[]) WITH ORDINALITY AS o(id, pos)
      WHERE s.id = o.id`,
    [Array.from(ids)],
  );
}

export async function archiveStatus(id: string): Promise<boolean> {
  if (!isDbConfigured()) return false;
  await ensureStatusesSchema();
  const q = sql();
  const rows = (await q`
    UPDATE crm_statuses SET archived_at = NOW(), updated_at = NOW()
     WHERE id = ${id} AND archived_at IS NULL
     RETURNING id
  `) as { id: string }[];
  return rows.length > 0;
}

/** Seed rows: inserted only when absent. Returns how many were inserted. */
export async function seedStatuses(rows: readonly CrmStatusInput[]): Promise<number> {
  if (!isDbConfigured()) return 0;
  await ensureStatusesSchema();
  const q = sql();
  let inserted = 0;
  for (const s of rows) {
    const out = (await q`
      INSERT INTO crm_statuses (id, label, kind, position, sla_label, sla_hours, on_board)
      VALUES (${s.id}, ${s.label}, ${s.kind}, ${s.position ?? 100}, ${s.slaLabel ?? null},
              ${s.slaHours ?? null}, ${s.onBoard ?? true})
      ON CONFLICT (id) DO NOTHING
      RETURNING id
    `) as { id: string }[];
    inserted += out.length;
  }
  return inserted;
}
