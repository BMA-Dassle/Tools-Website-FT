/**
 * `crm_templates` — SMS / email templates with `{{merge.fields}}` (brief §3.8,
 * R11: guest-facing copy renders from here, never from a component). Seeded
 * T-1..T-6 from `crm-data.js:375-382`.
 *
 * DDL is PR1's; C6 adds the readers and writers the Collateral screen's editor
 * needs, and nothing else. `merge_fields` is DERIVED on every write from the
 * subject and body (`mergeFieldsOf`) rather than trusted from the client — the
 * column exists so a later PR can ask "which templates use `contract.link`?"
 * without scanning bodies, and a stale answer there would be worse than none.
 */

import { isDbConfigured, sql } from "@ft/db";
import { isCentreCode } from "../../core/centres";
import type { CentreCode } from "../../core/types";
import type { MessageTemplate, TemplateKind } from "../contracts";
import { gsm7Verdict } from "../service/merge";

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
  kind: TemplateKind;
  name: string;
  subject?: string;
  body: string;
  position: number;
}

/** Every `{{a.b}}` token in a template, deduplicated, in order of appearance. */
export function mergeFieldsOf(...texts: (string | undefined | null)[]): string[] {
  const out: string[] = [];
  for (const t of texts) {
    if (!t) continue;
    for (const m of t.matchAll(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g)) {
      const key = m[1];
      if (key && !out.includes(key)) out.push(key);
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
// Rows (C6)
// ---------------------------------------------------------------------------

export interface TemplateRowRaw {
  id: string;
  kind: string;
  name: string;
  subject: string | null;
  body: string;
  merge_fields: string[] | null;
  centre: string | null;
  position: number | string;
  updated_by: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

const COLUMNS = `
  t.id::text AS id, t.kind, t.name, t.subject, t.body, t.merge_fields, t.centre, t.position,
  t.updated_by, t.archived_at::text AS archived_at,
  t.created_at::text AS created_at, t.updated_at::text AS updated_at
`;

/**
 * The GSM-7 verdict is attached HERE, on every read, rather than computed in
 * the editor: the list has to show which SMS template would cost double before
 * anyone opens it, and the send path has to see the same answer as the screen.
 */
export function mapTemplateRow(r: TemplateRowRaw): MessageTemplate {
  const kind: TemplateKind = r.kind === "email" ? "email" : "sms";
  return {
    id: String(r.id),
    kind,
    name: r.name,
    subject: r.subject ?? null,
    body: r.body,
    mergeFields: Array.isArray(r.merge_fields)
      ? r.merge_fields.filter((f) => typeof f === "string")
      : [],
    centre: isCentreCode(r.centre) ? r.centre : null,
    position: Number(r.position) || 0,
    updatedBy: r.updated_by ?? null,
    archivedAt: r.archived_at ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    gsm7: kind === "sms" ? gsm7Verdict(r.body) : null,
  };
}

export interface TemplateListFilter {
  kind?: TemplateKind | null;
  centre?: CentreCode | null;
  includeArchived?: boolean;
}

/** SMS first, then email, each in `position` order — the editor's list order. */
export async function listTemplates(filter: TemplateListFilter = {}): Promise<MessageTemplate[]> {
  if (!isDbConfigured()) return [];
  await ensureTemplatesSchema();
  const q = sql();
  const rows = (await q.query(
    `SELECT ${COLUMNS}
       FROM crm_templates t
      WHERE ($1::boolean OR t.archived_at IS NULL)
        AND ($2::text IS NULL OR t.kind = $2)
        AND ($3::text IS NULL OR t.centre = $3 OR t.centre IS NULL)
      ORDER BY (t.kind = 'email'), t.position ASC, t.id ASC
      LIMIT 200`,
    [filter.includeArchived === true, filter.kind ?? null, filter.centre ?? null],
  )) as TemplateRowRaw[];
  return rows.map(mapTemplateRow);
}

export async function getTemplate(id: string): Promise<MessageTemplate | null> {
  if (!isDbConfigured()) return null;
  await ensureTemplatesSchema();
  const q = sql();
  const rows = (await q.query(`SELECT ${COLUMNS} FROM crm_templates t WHERE t.id = $1::bigint`, [
    id,
  ])) as TemplateRowRaw[];
  return rows[0] ? mapTemplateRow(rows[0]) : null;
}

export interface TemplateWriteInput {
  id: string | null;
  kind: TemplateKind;
  name: string;
  subject: string | null;
  body: string;
  centre: CentreCode | null;
  position: number | null;
  actorEmail: string;
}

export async function upsertTemplate(input: TemplateWriteInput): Promise<MessageTemplate> {
  if (!isDbConfigured()) throw new Error("DATABASE_URL is not set");
  await ensureTemplatesSchema();
  const q = sql();
  const fields = mergeFieldsOf(input.subject, input.body);
  if (input.id) {
    const rows = (await q.query(
      `WITH upd AS (
         UPDATE crm_templates SET
           kind = $2, name = $3, subject = $4, body = $5, merge_fields = $6::text[],
           centre = $7, position = COALESCE($8, position), updated_by = $9, updated_at = NOW()
         WHERE id = $1::bigint
         RETURNING *
       )
       SELECT ${COLUMNS} FROM upd t`,
      [
        input.id,
        input.kind,
        input.name,
        input.subject,
        input.body,
        fields,
        input.centre,
        input.position,
        input.actorEmail,
      ],
    )) as TemplateRowRaw[];
    if (!rows[0]) throw new Error("template_not_found");
    return mapTemplateRow(rows[0]);
  }
  const rows = (await q.query(
    `WITH ins AS (
       INSERT INTO crm_templates (kind, name, subject, body, merge_fields, centre, position, updated_by)
       VALUES ($1, $2, $3, $4, $5::text[], $6,
               COALESCE($7, (SELECT COALESCE(MAX(position), 0) + 1 FROM crm_templates WHERE kind = $1)),
               $8)
       RETURNING *
     )
     SELECT ${COLUMNS} FROM ins t`,
    [
      input.kind,
      input.name,
      input.subject,
      input.body,
      fields,
      input.centre,
      input.position,
      input.actorEmail,
    ],
  )) as TemplateRowRaw[];
  return mapTemplateRow(rows[0]);
}

export async function setTemplateArchived(
  id: string,
  archived: boolean,
  actorEmail: string,
): Promise<MessageTemplate | null> {
  if (!isDbConfigured()) return null;
  await ensureTemplatesSchema();
  const q = sql();
  const rows = (await q.query(
    `WITH upd AS (
       UPDATE crm_templates SET
         archived_at = CASE WHEN $2::boolean THEN COALESCE(archived_at, NOW()) ELSE NULL END,
         updated_by = $3, updated_at = NOW()
       WHERE id = $1::bigint
       RETURNING *
     )
     SELECT ${COLUMNS} FROM upd t`,
    [id, archived, actorEmail],
  )) as TemplateRowRaw[];
  return rows[0] ? mapTemplateRow(rows[0]) : null;
}

/** Positions follow the order of `ids`, 1-based, in one statement. */
export async function reorderTemplates(ids: readonly string[], actorEmail: string): Promise<void> {
  if (!isDbConfigured() || ids.length === 0) return;
  await ensureTemplatesSchema();
  const q = sql();
  await q.query(
    `UPDATE crm_templates t SET position = o.ord, updated_by = $2, updated_at = NOW()
       FROM (SELECT id::bigint AS id, ord FROM unnest($1::bigint[]) WITH ORDINALITY AS u(id, ord)) o
      WHERE t.id = o.id`,
    [ids, actorEmail],
  );
}
