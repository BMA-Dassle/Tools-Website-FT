/**
 * `crm_templates` READERS AND WRITERS — the SMS sub's, because
 * `/api/admin/crm/templates` and the composer's picker are C1 deliverables
 * (brief §4, C1 Files).
 *
 * ── WHY THEY LIVE HERE AND NOT BESIDE THE DDL ───────────────────────
 *
 * The TABLE belongs to the collateral sub: PR1 wrote its `CREATE TABLE` and its
 * T-1..T-6 seed in `collateral/data/templates-db.ts`, and §3.8 makes that file
 * PR1's — a later PR may only `ADD COLUMN IF NOT EXISTS` there, and only when
 * it owns the sub. C1 owns neither, so the queries it needs live in C1's own
 * sub and call the owner's `ensureTemplatesSchema()` across the sub boundary
 * through `~/features/crm/collateral` (an index import, which §3.2 allows).
 *
 * C6's Template editor screen imports these three writers through
 * `~/features/crm/sms` rather than growing a second copy — one set of queries
 * for one table, whichever screen is in front of them.
 *
 * No schema of its own: `ensureTemplatesSchema()` is the collateral sub's and
 * is awaited by every public function here, exactly as §3.8's preamble requires.
 */

import { isDbConfigured, sql } from "@ft/db";
import { ensureTemplatesSchema, mergeFieldsOf } from "~/features/crm/collateral";
import type { CrmTemplate } from "../types";

export interface TemplateRowRaw {
  id: string;
  kind: string;
  name: string;
  subject: string | null;
  body: string;
  merge_fields: string[] | null;
  centre: string | null;
  position: number;
  archived_at: string | null;
}

export function mapTemplateRow(r: TemplateRowRaw): CrmTemplate {
  return {
    id: String(r.id),
    kind: r.kind === "email" ? "email" : "sms",
    name: r.name,
    subject: r.subject ?? null,
    body: r.body,
    mergeFields: r.merge_fields ?? [],
    centre: r.centre ?? null,
    position: typeof r.position === "number" ? r.position : Number(r.position ?? 100),
    archivedAt: r.archived_at ?? null,
  };
}

const TEMPLATE_COLUMNS = `
  id::text AS id, kind, name, subject, body, merge_fields, centre, position,
  to_char(archived_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS archived_at
`;

export interface TemplateFilter {
  kind?: "sms" | "email";
  centre?: string | null;
  includeArchived?: boolean;
}

/** Live templates in picker order; archived ones only when asked for. */
export async function listTemplates(filter: TemplateFilter = {}): Promise<CrmTemplate[]> {
  if (!isDbConfigured()) return [];
  await ensureTemplatesSchema();
  const q = sql();
  const rows = (await q.query(
    `SELECT ${TEMPLATE_COLUMNS} FROM crm_templates
      WHERE ($1::text IS NULL OR kind = $1)
        AND ($2::text IS NULL OR centre IS NULL OR centre = $2)
        AND ($3::boolean OR archived_at IS NULL)
      ORDER BY position ASC, id ASC`,
    [filter.kind ?? null, filter.centre ?? null, filter.includeArchived === true],
  )) as TemplateRowRaw[];
  return rows.map(mapTemplateRow);
}

export async function getTemplate(id: string): Promise<CrmTemplate | null> {
  if (!isDbConfigured()) return null;
  await ensureTemplatesSchema();
  const q = sql();
  const rows = (await q.query(
    `SELECT ${TEMPLATE_COLUMNS} FROM crm_templates WHERE id = $1::bigint`,
    [id],
  )) as TemplateRowRaw[];
  return rows[0] ? mapTemplateRow(rows[0]) : null;
}

export interface TemplateUpsert {
  id?: string | null;
  kind: "sms" | "email";
  name: string;
  subject?: string | null;
  body: string;
  centre?: string | null;
  position?: number;
}

/**
 * Insert or update one template. `merge_fields` is DERIVED from the text every
 * time, never supplied by the caller — a field list that disagrees with the
 * body is how a merge silently stops filling something.
 */
export async function upsertTemplate(
  input: TemplateUpsert,
  actorEmail: string,
): Promise<CrmTemplate | null> {
  if (!isDbConfigured()) return null;
  await ensureTemplatesSchema();
  const q = sql();
  const fields = mergeFieldsOf(input.subject ?? undefined, input.body);
  if (input.id) {
    const rows = (await q.query(
      `UPDATE crm_templates
          SET kind = $2, name = $3, subject = $4, body = $5, merge_fields = $6::text[],
              centre = $7, position = COALESCE($8::int, position), updated_by = $9, updated_at = NOW()
        WHERE id = $1::bigint
        RETURNING ${TEMPLATE_COLUMNS}`,
      [
        input.id,
        input.kind,
        input.name,
        input.subject ?? null,
        input.body,
        fields,
        input.centre ?? null,
        input.position ?? null,
        actorEmail,
      ],
    )) as TemplateRowRaw[];
    return rows[0] ? mapTemplateRow(rows[0]) : null;
  }
  const rows = (await q.query(
    `INSERT INTO crm_templates (kind, name, subject, body, merge_fields, centre, position, updated_by)
     VALUES ($1, $2, $3, $4, $5::text[], $6, COALESCE($7::int, 100), $8)
     RETURNING ${TEMPLATE_COLUMNS}`,
    [
      input.kind,
      input.name,
      input.subject ?? null,
      input.body,
      fields,
      input.centre ?? null,
      input.position ?? null,
      actorEmail,
    ],
  )) as TemplateRowRaw[];
  return rows[0] ? mapTemplateRow(rows[0]) : null;
}

/** Soft delete — a template that was used stays readable in the audit trail. */
export async function archiveTemplate(id: string, actorEmail: string): Promise<CrmTemplate | null> {
  if (!isDbConfigured()) return null;
  await ensureTemplatesSchema();
  const q = sql();
  const rows = (await q.query(
    `UPDATE crm_templates SET archived_at = NOW(), updated_by = $2, updated_at = NOW()
      WHERE id = $1::bigint
      RETURNING ${TEMPLATE_COLUMNS}`,
    [id, actorEmail],
  )) as TemplateRowRaw[];
  return rows[0] ? mapTemplateRow(rows[0]) : null;
}
