/**
 * `crm_quote_lines` — the builder's intent rows (brief §3.8, R5).
 *
 * **NEON FIRST, OFFICE SECOND.** The row exists here BEFORE the Office
 * `projectProduct` write and records that write's verdict (`write_status`,
 * `write_error`, `office_prompt`). Our database is the source of truth; Office
 * is a downstream sync. A quote a rep spent ten minutes building survives an
 * Office outage, a lambda timeout and a bad deploy, because it was written down
 * at the moment it was captured and not "best-effort after the API call"
 * (CLAUDE.md, the Pizza Bowl toppings incident).
 *
 * **IDEMPOTENT BY `bmi_project_product_id`.** A line that already carries one
 * has been written; re-running its step re-reads and verifies rather than
 * creating a second Office row. That id is the join key for every retry.
 *
 * DDL landed in PR1; C5 adds the readers and writers. Every id column is TEXT
 * because a 17-digit Office id is not a number.
 */

import { isDbConfigured, sql } from "@ft/db";
import { ensureLeadsSchema } from "~/features/crm/leads";
import type { OfficePrompt, QuoteLine, QuoteLineStatus, ScheduleBlock } from "../contracts";

let schemaReady: Promise<void> | null = null;

export function ensureQuoteLinesSchema(): Promise<void> {
  schemaReady ??= (async () => {
    await ensureLeadsSchema();
    const q = sql();
    await q`
      CREATE TABLE IF NOT EXISTS crm_quote_lines (
        id BIGSERIAL PRIMARY KEY,
        lead_id BIGINT NOT NULL REFERENCES crm_leads(id),
        bmi_project_id TEXT,
        product_id TEXT NOT NULL,
        product_name TEXT NOT NULL,
        name_override TEXT,
        quantity INTEGER NOT NULL,
        price_per_unit_cents BIGINT NOT NULL,
        price_date DATE,
        resource_id TEXT,
        schedule_blocks JSONB,
        bmi_project_product_id TEXT,
        bmi_schedule_ids JSONB,
        write_status TEXT NOT NULL DEFAULT 'pending' CHECK (write_status IN ('pending','written','failed','paused','removed')),
        write_error TEXT,
        office_prompt JSONB,
        actor_email TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
    await q`CREATE INDEX IF NOT EXISTS crm_quote_lines_lead ON crm_quote_lines (lead_id)`;
    // Two writers must never create two Office rows for one line. A partial
    // UNIQUE index is the cheapest guard: NULLs (a line not yet written) do
    // not collide, so it constrains exactly the rows that carry an Office id.
    await q`
      CREATE UNIQUE INDEX IF NOT EXISTS crm_quote_lines_pp
        ON crm_quote_lines (bmi_project_product_id)
        WHERE bmi_project_product_id IS NOT NULL
    `;
  })();
  return schemaReady;
}

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

export interface QuoteLineRowRaw {
  id: string;
  lead_id: string;
  bmi_project_id: string | null;
  product_id: string;
  product_name: string;
  name_override: string | null;
  quantity: number | string;
  price_per_unit_cents: number | string;
  price_date: string | Date | null;
  resource_id: string | null;
  schedule_blocks: unknown;
  bmi_project_product_id: string | null;
  bmi_schedule_ids: unknown;
  write_status: string;
  write_error: string | null;
  office_prompt: unknown;
  actor_email: string | null;
  created_at: string;
  updated_at: string;
}

const COLUMNS = `id::text AS id, lead_id::text AS lead_id, bmi_project_id, product_id,
  product_name, name_override, quantity, price_per_unit_cents::bigint AS price_per_unit_cents,
  price_date::text AS price_date, resource_id, schedule_blocks, bmi_project_product_id,
  bmi_schedule_ids, write_status, write_error, office_prompt, actor_email,
  created_at::text AS created_at, updated_at::text AS updated_at`;

function ymdOrNull(value: string | Date | null): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function blocksOf(value: unknown): ScheduleBlock[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((b) => {
    if (!b || typeof b !== "object") return [];
    const r = b as Record<string, unknown>;
    if (typeof r.resourceId !== "string" || typeof r.start !== "string") return [];
    return [
      {
        resourceId: r.resourceId,
        start: r.start,
        stop: typeof r.stop === "string" ? r.stop : r.start,
        persons: Number(r.persons) || 0,
      },
    ];
  });
}

function idsOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((x): x is string => typeof x === "string") : [];
}

function promptOf(value: unknown): OfficePrompt | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as { message?: unknown; operationId?: unknown };
  if (typeof v.message !== "string") return null;
  return {
    message: v.message,
    ...(typeof v.operationId === "string" ? { operationId: v.operationId } : {}),
  };
}

function statusOf(value: string): QuoteLineStatus {
  switch (value) {
    case "written":
    case "failed":
    case "paused":
    case "removed":
      return value;
    default:
      return "pending";
  }
}

export function mapQuoteLine(r: QuoteLineRowRaw): QuoteLine {
  return {
    id: r.id,
    leadId: r.lead_id,
    bmiProjectId: r.bmi_project_id,
    productId: r.product_id,
    productName: r.product_name,
    nameOverride: r.name_override,
    quantity: Number(r.quantity) || 0,
    pricePerUnitCents: Number(r.price_per_unit_cents) || 0,
    priceDate: ymdOrNull(r.price_date),
    resourceId: r.resource_id,
    scheduleBlocks: blocksOf(r.schedule_blocks),
    bmiProjectProductId: r.bmi_project_product_id,
    bmiScheduleIds: idsOf(r.bmi_schedule_ids),
    status: statusOf(r.write_status),
    writeError: r.write_error,
    officePrompt: promptOf(r.office_prompt),
    actorEmail: r.actor_email,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** Every line for a lead, oldest first — including removed ones, which the
 *  screen greys out rather than hiding, so a rep can see what they took off. */
export async function listQuoteLines(leadId: string): Promise<QuoteLine[]> {
  if (!isDbConfigured()) return [];
  await ensureQuoteLinesSchema();
  const q = sql();
  const rows = (await q.query(
    `SELECT ${COLUMNS} FROM crm_quote_lines WHERE lead_id = $1::bigint ORDER BY id ASC`,
    [leadId],
  )) as QuoteLineRowRaw[];
  return rows.map(mapQuoteLine);
}

export async function getQuoteLine(id: string): Promise<QuoteLine | null> {
  if (!isDbConfigured()) return null;
  await ensureQuoteLinesSchema();
  const q = sql();
  const rows = (await q.query(`SELECT ${COLUMNS} FROM crm_quote_lines WHERE id = $1::bigint`, [
    id,
  ])) as QuoteLineRowRaw[];
  return rows[0] ? mapQuoteLine(rows[0]) : null;
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export interface QuoteLineInput {
  leadId: string;
  bmiProjectId: string | null;
  productId: string;
  productName: string;
  nameOverride?: string | null;
  quantity: number;
  pricePerUnitCents: number;
  priceDate: string | null;
  actorEmail: string;
}

/**
 * Record the INTENT. Always `pending` — this row is written before Office is
 * called at all, and a caller that inserts it already `written` has skipped the
 * step this table exists for.
 */
export async function insertQuoteLine(input: QuoteLineInput): Promise<QuoteLine> {
  if (!isDbConfigured()) throw new Error("DATABASE_URL is not set");
  await ensureQuoteLinesSchema();
  const q = sql();
  const rows = (await q.query(
    `INSERT INTO crm_quote_lines
       (lead_id, bmi_project_id, product_id, product_name, name_override,
        quantity, price_per_unit_cents, price_date, actor_email, write_status)
     VALUES ($1::bigint, $2, $3, $4, $5, $6::int, $7::bigint, $8::date, $9, 'pending')
     RETURNING ${COLUMNS}`,
    [
      input.leadId,
      input.bmiProjectId,
      input.productId,
      input.productName,
      input.nameOverride ?? null,
      input.quantity,
      Math.round(input.pricePerUnitCents),
      input.priceDate,
      input.actorEmail,
    ],
  )) as QuoteLineRowRaw[];
  const row = rows[0];
  if (!row) throw new Error("crm_quote_lines: insert returned nothing");
  return mapQuoteLine(row);
}

export interface QuoteLinePatch {
  status?: QuoteLineStatus;
  bmiProjectId?: string | null;
  bmiProjectProductId?: string | null;
  bmiScheduleIds?: string[];
  resourceId?: string | null;
  scheduleBlocks?: ScheduleBlock[];
  quantity?: number;
  pricePerUnitCents?: number;
  priceDate?: string | null;
  /** Pass `null` explicitly to clear a previous failure. */
  writeError?: string | null;
  officePrompt?: OfficePrompt | null;
}

const PATCH_COLUMNS: Record<keyof QuoteLinePatch, { col: string; cast: string }> = {
  status: { col: "write_status", cast: "" },
  bmiProjectId: { col: "bmi_project_id", cast: "" },
  bmiProjectProductId: { col: "bmi_project_product_id", cast: "" },
  bmiScheduleIds: { col: "bmi_schedule_ids", cast: "::jsonb" },
  resourceId: { col: "resource_id", cast: "" },
  scheduleBlocks: { col: "schedule_blocks", cast: "::jsonb" },
  quantity: { col: "quantity", cast: "::int" },
  pricePerUnitCents: { col: "price_per_unit_cents", cast: "::bigint" },
  priceDate: { col: "price_date", cast: "::date" },
  writeError: { col: "write_error", cast: "" },
  officePrompt: { col: "office_prompt", cast: "::jsonb" },
};

/** JSONB columns need a string; everything else goes through as-is. */
function patchValue(key: keyof QuoteLinePatch, value: unknown): unknown {
  if (key === "bmiScheduleIds" || key === "scheduleBlocks" || key === "officePrompt") {
    return value == null ? null : JSON.stringify(value);
  }
  if (key === "pricePerUnitCents" && typeof value === "number") return Math.round(value);
  return value;
}

/**
 * Update one line and hand back what the row now says.
 *
 * A patch with no keys is a no-op read rather than invalid SQL: the caller that
 * decided nothing changed should not have to branch, and a bare
 * `UPDATE … SET  WHERE` is a syntax error rather than a helpful one.
 */
export async function patchQuoteLine(id: string, patch: QuoteLinePatch): Promise<QuoteLine | null> {
  if (!isDbConfigured()) return null;
  const keys = (Object.keys(patch) as Array<keyof QuoteLinePatch>).filter(
    (k) => patch[k] !== undefined,
  );
  if (keys.length === 0) return getQuoteLine(id);

  await ensureQuoteLinesSchema();
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const key of keys) {
    const spec = PATCH_COLUMNS[key];
    values.push(patchValue(key, patch[key]));
    sets.push(`${spec.col} = $${values.length}${spec.cast}`);
  }
  sets.push("updated_at = NOW()");
  values.push(id);

  const q = sql();
  const rows = (await q.query(
    `UPDATE crm_quote_lines SET ${sets.join(", ")} WHERE id = $${values.length}::bigint
     RETURNING ${COLUMNS}`,
    values,
  )) as QuoteLineRowRaw[];
  return rows[0] ? mapQuoteLine(rows[0]) : null;
}

/**
 * Adopt an Office `projectProduct.id` onto a line, but ONLY while it has none.
 *
 * The conditional is the idempotency guard: if two requests raced and one
 * already recorded an id, the loser gets `null` back and knows to delete the
 * duplicate it just created in Office rather than overwriting the winner's id
 * and orphaning a row nobody will ever clean up.
 */
export async function claimProjectProductId(
  id: string,
  bmiProjectProductId: string,
  bmiProjectId: string,
): Promise<QuoteLine | null> {
  if (!isDbConfigured()) return null;
  await ensureQuoteLinesSchema();
  const q = sql();
  const rows = (await q.query(
    `UPDATE crm_quote_lines
        SET bmi_project_product_id = $2,
            bmi_project_id = $3,
            write_status = 'written',
            write_error = NULL,
            office_prompt = NULL,
            updated_at = NOW()
      WHERE id = $1::bigint AND bmi_project_product_id IS NULL
      RETURNING ${COLUMNS}`,
    [id, bmiProjectProductId, bmiProjectId],
  )) as QuoteLineRowRaw[];
  return rows[0] ? mapQuoteLine(rows[0]) : null;
}

/** Lines a retry should pick up: recorded here, not yet accepted by Office. */
export async function listUnwrittenLines(leadId: string): Promise<QuoteLine[]> {
  const lines = await listQuoteLines(leadId);
  return lines.filter(
    (l) => l.status === "pending" || l.status === "paused" || l.status === "failed",
  );
}
