/**
 * `crm_quote_templates` — reusable line sets for the builder (brief §3.8).
 *
 * `lines` is `[{productId, per?, min?}]` — THE canonical shape; qty =
 * per ? max(min ?? 1, ceil(guests / per)) : (min ?? 1). The scaling itself is
 * pure and lives in `../service/templates.ts`.
 *
 * **NO PRICE IS EVER STORED HERE.** Weekday and weekend are different numbers
 * and Office owns both; a template that remembered a price would quote last
 * season's rate the first time the catalogue moved, which is the "published
 * price must match the catalogue" incident with extra steps. A template
 * remembers WHAT and HOW MANY. The builder asks Office HOW MUCH, for the
 * event's own date, every time.
 *
 * `uses` is incremented when a quote is started from a template, so a stale
 * package surfaces as a low number beside a popular one rather than sitting
 * there forever because nobody noticed.
 */

import { isDbConfigured, sql } from "@ft/db";
import { isCentreCode } from "~/features/crm/core/centres";
import type { CentreCode } from "~/features/crm/core/types";
import type { QuoteTemplate, TemplateLine } from "../contracts";

let schemaReady: Promise<void> | null = null;

export function ensureQuoteTemplatesSchema(): Promise<void> {
  schemaReady ??= (async () => {
    const q = sql();
    await q`
      CREATE TABLE IF NOT EXISTS crm_quote_templates (
        id BIGSERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        centre TEXT,
        baseline_guests INTEGER NOT NULL,
        description TEXT,
        lines JSONB NOT NULL,
        uses INTEGER NOT NULL DEFAULT 0,
        is_new BOOLEAN NOT NULL DEFAULT TRUE,
        created_by TEXT,
        archived_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
    await q`
      CREATE INDEX IF NOT EXISTS crm_quote_templates_live
        ON crm_quote_templates (centre, uses DESC)
        WHERE archived_at IS NULL
    `;
  })();
  return schemaReady;
}

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

export interface QuoteTemplateRowRaw {
  id: string;
  name: string;
  centre: string | null;
  baseline_guests: number | string;
  description: string | null;
  lines: unknown;
  uses: number | string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

const COLUMNS = `id::text AS id, name, centre, baseline_guests, description, lines, uses,
  created_by, created_at::text AS created_at, updated_at::text AS updated_at`;

/**
 * Decode the stored `lines` defensively.
 *
 * A row is JSONB a human may have edited by hand, so anything that is not a
 * `{productId: string}` object is DROPPED rather than allowed through as a
 * line with an undefined product. Silently quoting a product that does not
 * exist is worse than quoting one line fewer and being asked why.
 */
export function templateLinesOf(value: unknown): TemplateLine[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw) => {
    if (!raw || typeof raw !== "object") return [];
    const r = raw as Record<string, unknown>;
    const productId = typeof r.productId === "string" ? r.productId : String(r.productId ?? "");
    if (!productId) return [];
    const line: TemplateLine = { productId };
    if (typeof r.productName === "string") line.productName = r.productName;
    const per = Number(r.per);
    if (Number.isFinite(per) && per > 0) line.per = per;
    const min = Number(r.min);
    if (Number.isFinite(min) && min > 0) line.min = min;
    return [line];
  });
}

function centreOf(value: string | null): CentreCode | null {
  return value && isCentreCode(value) ? value : null;
}

export function mapQuoteTemplate(r: QuoteTemplateRowRaw): QuoteTemplate {
  return {
    id: r.id,
    name: r.name,
    centre: centreOf(r.centre),
    baselineGuests: Number(r.baseline_guests) || 0,
    description: r.description,
    lines: templateLinesOf(r.lines),
    uses: Number(r.uses) || 0,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * Live templates for a centre: that centre's own, plus every "all centres"
 * one. Most-used first, so the package the desk actually sells is the first
 * thing a rep sees and the one nobody has touched in a year sinks.
 */
export async function listQuoteTemplates(centre?: CentreCode | null): Promise<QuoteTemplate[]> {
  if (!isDbConfigured()) return [];
  await ensureQuoteTemplatesSchema();
  const q = sql();
  const rows = (await q.query(
    `SELECT ${COLUMNS} FROM crm_quote_templates
      WHERE archived_at IS NULL AND ($1::text IS NULL OR centre IS NULL OR centre = $1)
      ORDER BY uses DESC, name ASC`,
    [centre ?? null],
  )) as QuoteTemplateRowRaw[];
  return rows.map(mapQuoteTemplate);
}

export async function getQuoteTemplate(id: string): Promise<QuoteTemplate | null> {
  if (!isDbConfigured()) return null;
  await ensureQuoteTemplatesSchema();
  const q = sql();
  const rows = (await q.query(
    `SELECT ${COLUMNS} FROM crm_quote_templates WHERE id = $1::bigint AND archived_at IS NULL`,
    [id],
  )) as QuoteTemplateRowRaw[];
  return rows[0] ? mapQuoteTemplate(rows[0]) : null;
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export interface QuoteTemplateInput {
  name: string;
  centre: CentreCode | null;
  baselineGuests: number;
  description: string | null;
  lines: TemplateLine[];
  createdBy: string;
}

export async function insertQuoteTemplate(input: QuoteTemplateInput): Promise<QuoteTemplate> {
  if (!isDbConfigured()) throw new Error("DATABASE_URL is not set");
  await ensureQuoteTemplatesSchema();
  const q = sql();
  const rows = (await q.query(
    `INSERT INTO crm_quote_templates
       (name, centre, baseline_guests, description, lines, created_by)
     VALUES ($1, $2, $3::int, $4, $5::jsonb, $6)
     RETURNING ${COLUMNS}`,
    [
      input.name,
      input.centre,
      Math.max(1, Math.round(input.baselineGuests)),
      input.description,
      JSON.stringify(input.lines),
      input.createdBy,
    ],
  )) as QuoteTemplateRowRaw[];
  const row = rows[0];
  if (!row) throw new Error("crm_quote_templates: insert returned nothing");
  return mapQuoteTemplate(row);
}

/**
 * Count one use, and clear `is_new` while we are there.
 *
 * Never throws: the quote it describes has already been built, and failing the
 * rep's request because a counter did not move would make them redo work that
 * landed. A lost increment is a slightly wrong sort order, nothing more.
 */
export async function bumpTemplateUse(id: string): Promise<void> {
  if (!isDbConfigured()) return;
  try {
    await ensureQuoteTemplatesSchema();
    const q = sql();
    await q`
      UPDATE crm_quote_templates
         SET uses = uses + 1, is_new = FALSE, updated_at = NOW()
       WHERE id = ${id}::bigint
    `;
  } catch (err) {
    console.error("[crm] template use count failed", {
      template_id: id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Soft delete — a template a quote was built from is history, never deleted. */
export async function archiveQuoteTemplate(id: string): Promise<boolean> {
  if (!isDbConfigured()) return false;
  await ensureQuoteTemplatesSchema();
  const q = sql();
  const rows = (await q.query(
    `UPDATE crm_quote_templates SET archived_at = NOW(), updated_at = NOW()
      WHERE id = $1::bigint AND archived_at IS NULL RETURNING id::text AS id`,
    [id],
  )) as Array<{ id: string }>;
  return rows.length > 0;
}
