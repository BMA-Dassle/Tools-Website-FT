/**
 * `crm_templates` — SMS / email templates with `{{merge.fields}}` (brief §3.8,
 * R11: guest-facing copy renders from here, never from a component). Seeded
 * T-1..T-6 from `crm-data.js:375-382`.
 */

import { isDbConfigured, sql } from "@ft/db";

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
