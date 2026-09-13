/**
 * `crm_templates` — SMS / email templates with `{{merge.fields}}` (brief §3.8,
 * R11: guest-facing copy renders from here, never from a component). Seeded
 * T-1..T-6 from `crm-data.js:375-382`.
 *
 * DDL and the seed are PR1's. C1 adds the READERS and WRITERS (no DDL change)
 * because `/api/admin/crm/templates` is a C1 deliverable and the picker in the
 * SMS composer is its first consumer; C6's Template editor screen uses the same
 * three functions rather than a second copy.
 */

import { isDbConfigured, sql } from "@ft/db";
// Type-only (erased at compile time), so this is not a cross-sub runtime edge:
// `sms/types.ts` is the client-safe file that already names the wire shape.
import type { CrmTemplate } from "~/features/crm/sms/types";

let schemaReady: Promise<void> | null = null;

export function ensureTemplatesSchema(): Promise<void> {
  schemaReady ??= (async () => {
    const q = sql();
    await q`
      CREATE TABLE IF NOT EXISTS crm_templates (
        id BIGSERIAL PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('sms','email')),
        name TEXT NOT NULL,
        subject TEXT,
        body TEXT NOT NULL,
        merge_fields TEXT[] NOT NULL DEFAULT '{}',
        centre TEXT,
        position INTEGER NOT NULL DEFAULT 100,
        updated_by TEXT,
        archived_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
  })();
  return schemaReady;
}

export interface TemplateSeed {
  kind: "sms" | "email";
  name: string;
  subject?: string;
  body: string;
  position: number;
}

/** Every `{{a.b}}` token in a template, deduplicated, in order of appearance. */
export function mergeFieldsOf(...texts: (string | undefined)[]): string[] {
  const out: string[] = [];
  for (const t of texts) {
    if (!t) continue;
    for (const m of t.matchAll(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g)) {
      if (!out.includes(m[1])) out.push(m[1]);
    }
  }
  return out;
}

/**
 * Seed rows, inserted only when no template with the same (kind, name) exists
 * — the natural key a director would recognise. Returns how many were inserted.
 */
export async function seedTemplates(rows: readonly TemplateSeed[]): Promise<number> {
  if (!isDbConfigured()) return 0;
  await ensureTemplatesSchema();
  const q = sql();
  let inserted = 0;
  for (const t of rows) {
    const fields = mergeFieldsOf(t.subject, t.body);
    const out = (await q`
      INSERT INTO crm_templates (kind, name, subject, body, merge_fields, position, updated_by)
      SELECT ${t.kind}, ${t.name}, ${t.subject ?? null}, ${t.body}, ${fields}::text[], ${t.position}, 'seed'
      WHERE NOT EXISTS (SELECT 1 FROM crm_templates WHERE kind = ${t.kind} AND name = ${t.name})
      RETURNING id
    `) as { id: string }[];
    inserted += out.length;
  }
  return inserted;
}

// ---------------------------------------------------------------------------
// Readers / writers (C1)
// ---------------------------------------------------------------------------

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
