/**
 * `crm_cold_rows` — one prospect per row, with its disposition (brief §3.8).
 * A cold row has NO SMS consent (R8): the dialling list offers Call / Email
 * only until an inbound message exists.
 *
 * DDL BELONGS TO PR1. C8's own columns are added below with
 * `ADD COLUMN IF NOT EXISTS` (§3.8); the table count in `core/schema.ts` is
 * unchanged.
 *
 * THE RAW RECORD IS THE TRUTH. `raw` holds the file's cells exactly as they
 * arrived, keyed by the column name the parser found, and it is written BEFORE
 * any mapping or matching happens (R2 — persist guest-supplied data at
 * capture, CLAUDE.md). Every typed column here is a PROJECTION of `raw`
 * through the list's `column_map`, so a mis-mapped import is re-mapped rather
 * than re-uploaded, and a column the operator skipped is still on file.
 */

import { isDbConfigured, sql } from "@ft/db";
import type {
  ColdDecision,
  ColdDisposition,
  ColdMatchKey,
  ColdRowFilter,
  ColdRowStatus,
  ColdRowView,
} from "../contracts";
import type { ColdCandidate } from "../dedupe";
import { ensureColdListsSchema } from "./lists-db";

let schemaReady: Promise<void> | null = null;

export function ensureColdRowsSchema(): Promise<void> {
  schemaReady ??= (async () => {
    await ensureColdListsSchema();
    const q = sql();
    await q`
      CREATE TABLE IF NOT EXISTS crm_cold_rows (
        id BIGSERIAL PRIMARY KEY,
        list_id BIGINT NOT NULL REFERENCES crm_cold_lists(id),
        company TEXT,
        contact_name TEXT,
        phone_e164 TEXT,
        email TEXT,
        city TEXT,
        notes TEXT,
        raw JSONB,
        account_id BIGINT,
        lead_id BIGINT,
        disposition TEXT,
        disposition_at TIMESTAMPTZ,
        disposition_by TEXT,
        callback_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
    await q`CREATE INDEX IF NOT EXISTS crm_cold_rows_list ON crm_cold_rows (list_id, disposition)`;
    // C8's own columns (ADD COLUMN IF NOT EXISTS only — §3.8).
    await q`ALTER TABLE crm_cold_rows ADD COLUMN IF NOT EXISTS row_index INTEGER NOT NULL DEFAULT 0`;
    await q`ALTER TABLE crm_cold_rows ADD COLUMN IF NOT EXISTS phone_raw TEXT`;
    await q`ALTER TABLE crm_cold_rows ADD COLUMN IF NOT EXISTS email_key TEXT`;
    // TEXT, never BIGINT: a 17-digit Office person id exceeds Number.MAX_SAFE_INTEGER.
    await q`ALTER TABLE crm_cold_rows ADD COLUMN IF NOT EXISTS bmi_person_id TEXT`;
    await q`ALTER TABLE crm_cold_rows ADD COLUMN IF NOT EXISTS contact_id BIGINT`;
    await q`ALTER TABLE crm_cold_rows ADD COLUMN IF NOT EXISTS matched_by TEXT`;
    await q`ALTER TABLE crm_cold_rows ADD COLUMN IF NOT EXISTS decision TEXT NOT NULL DEFAULT 'new'`;
    await q`ALTER TABLE crm_cold_rows ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'staged'`;
    await q`ALTER TABLE crm_cold_rows ADD COLUMN IF NOT EXISTS disposition_note TEXT`;
    await q`ALTER TABLE crm_cold_rows ADD COLUMN IF NOT EXISTS touch_count INTEGER NOT NULL DEFAULT 0`;
    await q`ALTER TABLE crm_cold_rows ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`;
    // The chunked upload re-posts a chunk on a retry; this makes that a no-op.
    await q`
      CREATE UNIQUE INDEX IF NOT EXISTS crm_cold_rows_list_index
        ON crm_cold_rows (list_id, row_index)
    `;
    await q`CREATE INDEX IF NOT EXISTS crm_cold_rows_order ON crm_cold_rows (list_id, row_index, id)`;
    await q`CREATE INDEX IF NOT EXISTS crm_cold_rows_phone ON crm_cold_rows (phone_e164)`;
  })();
  return schemaReady;
}

const ISO = (col: string) => `to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

const ROW_SELECT = `
  cr.id::text AS id, cr.list_id::text AS list_id, cr.row_index, cr.company, cr.contact_name,
  cr.phone_e164, cr.phone_raw, cr.email, cr.email_key, cr.city, cr.notes, cr.bmi_person_id,
  cr.account_id::text AS account_id, cr.contact_id::text AS contact_id, cr.lead_id::text AS lead_id,
  cr.matched_by, cr.decision, cr.status, cr.disposition, cr.disposition_note,
  ${ISO("cr.disposition_at")} AS disposition_at, cr.disposition_by,
  ${ISO("cr.callback_at")} AS callback_at, cr.touch_count,
  ${ISO("cr.created_at")} AS created_at,
  a.name AS account_name, l.public_id AS lead_public_id
`;

const ROW_FROM = `
  FROM crm_cold_rows cr
  LEFT JOIN crm_accounts a ON a.id = cr.account_id
  LEFT JOIN crm_leads l ON l.id = cr.lead_id
`;

export interface ColdRowRaw {
  id: string;
  list_id: string;
  row_index: number | string | null;
  company: string | null;
  contact_name: string | null;
  phone_e164: string | null;
  phone_raw: string | null;
  email: string | null;
  email_key: string | null;
  city: string | null;
  notes: string | null;
  bmi_person_id: string | null;
  account_id: string | null;
  contact_id: string | null;
  lead_id: string | null;
  matched_by: string | null;
  decision: string | null;
  status: string | null;
  disposition: string | null;
  disposition_note: string | null;
  disposition_at: string | null;
  disposition_by: string | null;
  callback_at: string | null;
  touch_count: number | string | null;
  created_at: string;
  account_name: string | null;
  lead_public_id: string | null;
}

const DECISIONS = new Set<ColdDecision>(["link", "skip", "new"]);
const ROW_STATUSES = new Set<ColdRowStatus>(["staged", "ready", "skipped"]);
const MATCH_KEYS = new Set<ColdMatchKey>([
  "bmi_person_id",
  "phone",
  "email",
  "account_name",
  "in_file",
]);

export function mapColdRow(r: ColdRowRaw): ColdRowView {
  const decision = (r.decision ?? "new") as ColdDecision;
  const status = (r.status ?? "staged") as ColdRowStatus;
  const matched = (r.matched_by ?? null) as ColdMatchKey | null;
  return {
    id: String(r.id),
    listId: String(r.list_id),
    rowIndex: Number(r.row_index ?? 0) || 0,
    company: r.company ?? null,
    contactName: r.contact_name ?? null,
    phoneE164: r.phone_e164 ?? null,
    phoneRaw: r.phone_raw ?? null,
    email: r.email ?? null,
    city: r.city ?? null,
    notes: r.notes ?? null,
    bmiPersonId: r.bmi_person_id ?? null,
    accountId: r.account_id ?? null,
    accountName: r.account_name ?? null,
    contactId: r.contact_id ?? null,
    leadId: r.lead_id ?? null,
    leadPublicId: r.lead_public_id ?? null,
    matchedBy: matched && MATCH_KEYS.has(matched) ? matched : null,
    decision: DECISIONS.has(decision) ? decision : "new",
    status: ROW_STATUSES.has(status) ? status : "staged",
    disposition: (r.disposition as ColdDisposition | null) ?? null,
    dispositionNote: r.disposition_note ?? null,
    dispositionAt: r.disposition_at ?? null,
    dispositionBy: r.disposition_by ?? null,
    callbackAt: r.callback_at ?? null,
    touchCount: Number(r.touch_count ?? 0) || 0,
    createdAt: r.created_at,
  };
}

// ---------------------------------------------------------------------------
// The upload: raw records first, nothing else
// ---------------------------------------------------------------------------

export interface ColdRawRecord {
  index: number;
  values: Record<string, string>;
}

/**
 * Store one chunk of the file. NOTHING but `raw`, `row_index` and the list is
 * written here — no mapping, no matching, no external call — so the operator's
 * data is safe on our side before any of the rest can fail.
 *
 * `ON CONFLICT (list_id, row_index) DO NOTHING` makes a re-posted chunk a
 * no-op, which is what a browser retry looks like.
 */
export async function insertColdRows(
  listId: string,
  records: readonly ColdRawRecord[],
): Promise<number> {
  if (!isDbConfigured() || records.length === 0) return 0;
  await ensureColdRowsSchema();
  const q = sql();
  const params: unknown[] = [listId];
  const values = records.map((rec) => {
    params.push(rec.index, JSON.stringify(rec.values ?? {}));
    return `($1::bigint, $${params.length - 1}::int, $${params.length}::jsonb)`;
  });
  const rows = (await q.query(
    `INSERT INTO crm_cold_rows (list_id, row_index, raw)
     VALUES ${values.join(", ")}
     ON CONFLICT (list_id, row_index) DO NOTHING
     RETURNING id`,
    params,
  )) as { id: string }[];
  return rows.length;
}

/** Every stored raw record for one list, oldest line first, in pages. */
export async function listColdRawRecords(
  listId: string,
  afterRowIndex: number,
  limit: number,
): Promise<{ id: string; rowIndex: number; raw: Record<string, unknown> }[]> {
  if (!isDbConfigured()) return [];
  await ensureColdRowsSchema();
  const q = sql();
  const rows = (await q.query(
    `SELECT id::text AS id, row_index, raw FROM crm_cold_rows
      WHERE list_id = $1::bigint AND row_index > $2::int
      ORDER BY row_index ASC, id ASC
      LIMIT $3::int`,
    [listId, afterRowIndex, limit],
  )) as { id: string; row_index: number | string; raw: unknown }[];
  return rows.map((r) => ({
    id: String(r.id),
    rowIndex: Number(r.row_index ?? 0) || 0,
    raw:
      r.raw && typeof r.raw === "object" && !Array.isArray(r.raw)
        ? (r.raw as Record<string, unknown>)
        : {},
  }));
}

// ---------------------------------------------------------------------------
// The mapping pass
// ---------------------------------------------------------------------------

/** One row's projection plus its verdict, ready to be written back. */
export interface ColdRowProjectionPatch {
  id: string;
  company: string | null;
  contactName: string | null;
  phoneE164: string | null;
  phoneRaw: string | null;
  email: string | null;
  emailKey: string | null;
  city: string | null;
  notes: string | null;
  bmiPersonId: string | null;
  accountId: string | null;
  contactId: string | null;
  matchedBy: ColdMatchKey | null;
  decision: ColdDecision;
}

/**
 * Write a page of projections in ONE statement.
 *
 * A per-row UPDATE would be a round trip per row; an `UPDATE … FROM (VALUES …)`
 * is a single statement per page, which is what keeps a 10,000-row list inside
 * one 60-second function.
 *
 * A row that has already been dispositioned keeps its disposition — re-mapping
 * a list must never erase the calls a rep has already made.
 */
export async function applyColdProjections(
  patches: readonly ColdRowProjectionPatch[],
): Promise<number> {
  if (!isDbConfigured() || patches.length === 0) return 0;
  await ensureColdRowsSchema();
  const q = sql();
  const params: unknown[] = [];
  const tuples = patches.map((p) => {
    const start = params.length;
    params.push(
      p.id,
      p.company,
      p.contactName,
      p.phoneE164,
      p.phoneRaw,
      p.email,
      p.emailKey,
      p.city,
      p.notes,
      p.bmiPersonId,
      p.accountId,
      p.contactId,
      p.matchedBy,
      p.decision,
    );
    const h = (n: number) => `$${start + n}`;
    return `(${h(1)}::bigint, ${h(2)}, ${h(3)}, ${h(4)}, ${h(5)}, ${h(6)}, ${h(7)}, ${h(8)}, ${h(9)}, ${h(10)}, ${h(11)}::bigint, ${h(12)}::bigint, ${h(13)}, ${h(14)})`;
  });
  const rows = (await q.query(
    `UPDATE crm_cold_rows cr
        SET company = v.company, contact_name = v.contact_name, phone_e164 = v.phone_e164,
            phone_raw = v.phone_raw, email = v.email, email_key = v.email_key, city = v.city,
            notes = v.notes, bmi_person_id = v.bmi_person_id, account_id = v.account_id,
            contact_id = v.contact_id, matched_by = v.matched_by, decision = v.decision,
            updated_at = NOW()
       FROM (VALUES ${tuples.join(", ")}) AS v (id, company, contact_name, phone_e164, phone_raw,
             email, email_key, city, notes, bmi_person_id, account_id, contact_id, matched_by, decision)
      WHERE cr.id = v.id
      RETURNING cr.id`,
    params,
  )) as { id: string }[];
  return rows.length;
}

/**
 * The candidates for a page of rows: contacts whose person id, phone or email
 * matches, plus accounts whose `name_key` matches. One query per page, not per
 * row.
 */
export async function findColdCandidates(keys: {
  bmiPersonIds: readonly string[];
  phones: readonly string[];
  emails: readonly string[];
  nameKeys: readonly string[];
}): Promise<ColdCandidate[]> {
  if (!isDbConfigured()) return [];
  const { bmiPersonIds, phones, emails, nameKeys } = keys;
  if (bmiPersonIds.length + phones.length + emails.length + nameKeys.length === 0) return [];
  await ensureColdRowsSchema();
  const q = sql();

  const out: ColdCandidate[] = [];
  if (bmiPersonIds.length + phones.length + emails.length > 0) {
    const params: unknown[] = [];
    const inList = (vals: readonly string[]) =>
      vals.map((v) => {
        params.push(v);
        return `$${params.length}`;
      });
    const clauses: string[] = [];
    if (bmiPersonIds.length)
      clauses.push(`c.bmi_person_id IN (${inList(bmiPersonIds).join(", ")})`);
    if (phones.length) clauses.push(`c.phone_e164 IN (${inList(phones).join(", ")})`);
    if (emails.length) clauses.push(`c.email_key IN (${inList(emails).join(", ")})`);
    const rows = (await q.query(
      `SELECT c.id::text AS contact_id, c.account_id::text AS account_id, a.name AS account_name,
              nullif(trim(concat_ws(' ', c.first_name, c.last_name)), '') AS contact_name,
              c.bmi_person_id, c.phone_e164, c.email_key, a.name_key
         FROM crm_contacts c
         LEFT JOIN crm_accounts a ON a.id = c.account_id
        WHERE ${clauses.join(" OR ")}
        LIMIT 5000`,
      params,
    )) as {
      contact_id: string;
      account_id: string | null;
      account_name: string | null;
      contact_name: string | null;
      bmi_person_id: string | null;
      phone_e164: string | null;
      email_key: string | null;
      name_key: string | null;
    }[];
    for (const r of rows) {
      out.push({
        contactId: String(r.contact_id),
        accountId: r.account_id ?? null,
        accountName: r.account_name ?? null,
        contactName: r.contact_name ?? null,
        bmiPersonId: r.bmi_person_id ?? null,
        phoneE164: r.phone_e164 ?? null,
        emailKey: r.email_key ?? null,
        nameKey: r.name_key ?? null,
      });
    }
  }

  if (nameKeys.length) {
    const params: unknown[] = [];
    const holes = nameKeys.map((v) => {
      params.push(v);
      return `$${params.length}`;
    });
    const rows = (await q.query(
      `SELECT a.id::text AS account_id, a.name AS account_name, a.name_key
         FROM crm_accounts a
        WHERE a.name_key IN (${holes.join(", ")}) AND a.archived_at IS NULL
        LIMIT 5000`,
      params,
    )) as { account_id: string; account_name: string; name_key: string }[];
    for (const r of rows) {
      out.push({
        contactId: null,
        accountId: String(r.account_id),
        accountName: r.account_name,
        contactName: null,
        bmiPersonId: null,
        phoneE164: null,
        emailKey: null,
        nameKey: r.name_key,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Reading the dialling list
// ---------------------------------------------------------------------------

function filterClause(filter: ColdRowFilter): string {
  switch (filter) {
    case "todo":
      return "cr.status = 'ready' AND cr.disposition IS NULL";
    case "interested":
      return "cr.status <> 'skipped' AND cr.disposition = 'Interested'";
    case "callbacks":
      return "cr.status <> 'skipped' AND cr.callback_at IS NOT NULL";
    case "matched":
      return "cr.matched_by IS NOT NULL";
    case "skipped":
      return "cr.status = 'skipped'";
    default:
      return "cr.status <> 'skipped'";
  }
}

export function encodeColdCursor(row: { rowIndex: number; id: string }): string {
  return Buffer.from(`${row.rowIndex}:${row.id}`, "utf8").toString("base64url");
}

export function decodeColdCursor(
  cursor: string | null | undefined,
): { rowIndex: number; id: string } | null {
  if (!cursor) return null;
  try {
    const [a, b] = Buffer.from(cursor, "base64url").toString("utf8").split(":");
    if (!a || !b || !/^\d+$/.test(a) || !/^\d+$/.test(b)) return null;
    return { rowIndex: Number(a), id: b };
  } catch {
    return null;
  }
}

export interface ColdRowsPage {
  rows: ColdRowView[];
  nextCursor: string | null;
}

/** Keyset only (R10) — `(row_index, id)`, never OFFSET. */
export async function listColdRows(
  listId: string,
  opts: { filter?: ColdRowFilter; cursor?: string | null; limit?: number } = {},
): Promise<ColdRowsPage> {
  if (!isDbConfigured()) return { rows: [], nextCursor: null };
  await ensureColdRowsSchema();
  const q = sql();
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 200);
  const after = decodeColdCursor(opts.cursor);
  const params: unknown[] = [listId];
  let keyset = "";
  if (after) {
    params.push(after.rowIndex, after.id);
    keyset = ` AND (cr.row_index, cr.id) > ($${params.length - 1}::int, $${params.length}::bigint)`;
  }
  params.push(limit + 1);
  const rows = (await q.query(
    `SELECT ${ROW_SELECT} ${ROW_FROM}
      WHERE cr.list_id = $1::bigint AND ${filterClause(opts.filter ?? "all")}${keyset}
      ORDER BY cr.row_index ASC, cr.id ASC
      LIMIT $${params.length}::int`,
    params,
  )) as ColdRowRaw[];
  const page = rows.slice(0, limit).map(mapColdRow);
  const nextCursor =
    rows.length > limit && page.length > 0
      ? encodeColdCursor(page[page.length - 1] as ColdRowView)
      : null;
  return { rows: page, nextCursor };
}

export async function getColdRow(id: string): Promise<ColdRowView | null> {
  if (!isDbConfigured()) return null;
  await ensureColdRowsSchema();
  const q = sql();
  const rows = (await q.query(`SELECT ${ROW_SELECT} ${ROW_FROM} WHERE cr.id = $1::bigint`, [
    id,
  ])) as ColdRowRaw[];
  return rows[0] ? mapColdRow(rows[0]) : null;
}

/**
 * "Dial next" (`crm-shared.js:439`): the next row worth ringing — never called,
 * not skipped, has a number — plus any callback whose time has come, which
 * jumps the queue because the rep promised a time.
 */
export async function nextColdRow(listId: string): Promise<ColdRowView | null> {
  if (!isDbConfigured()) return null;
  await ensureColdRowsSchema();
  const q = sql();
  const rows = (await q.query(
    `SELECT ${ROW_SELECT} ${ROW_FROM}
      WHERE cr.list_id = $1::bigint AND cr.status = 'ready' AND cr.phone_e164 IS NOT NULL
        AND (cr.disposition IS NULL OR (cr.callback_at IS NOT NULL AND cr.callback_at <= NOW()))
      ORDER BY (cr.callback_at IS NOT NULL AND cr.callback_at <= NOW()) DESC,
               cr.callback_at ASC NULLS LAST, cr.row_index ASC, cr.id ASC
      LIMIT 1`,
    [listId],
  )) as ColdRowRaw[];
  return rows[0] ? mapColdRow(rows[0]) : null;
}

// ---------------------------------------------------------------------------
// Writers
// ---------------------------------------------------------------------------

/** One operator decision on a matched row. */
export async function setColdRowDecision(rowId: string, decision: ColdDecision): Promise<void> {
  if (!isDbConfigured()) return;
  await ensureColdRowsSchema();
  const q = sql();
  await q.query(
    `UPDATE crm_cold_rows SET decision = $2, updated_at = NOW() WHERE id = $1::bigint`,
    [rowId, decision],
  );
}

export interface ColdCommitCounts {
  imported: number;
  linked: number;
  skipped: number;
}

/**
 * Commit the mapping: every staged row becomes `ready`, except those the
 * operator chose to skip. Idempotent — running it twice changes nothing, and
 * it never touches a row a rep has since dispositioned.
 */
export async function commitColdRows(listId: string): Promise<ColdCommitCounts> {
  if (!isDbConfigured()) return { imported: 0, linked: 0, skipped: 0 };
  await ensureColdRowsSchema();
  const q = sql();
  await q.query(
    `UPDATE crm_cold_rows
        SET status = CASE WHEN decision = 'skip' THEN 'skipped' ELSE 'ready' END,
            updated_at = NOW()
      WHERE list_id = $1::bigint AND disposition IS NULL`,
    [listId],
  );
  const rows = (await q.query(
    `SELECT count(*) FILTER (WHERE status <> 'skipped')::int AS imported,
            count(*) FILTER (WHERE status <> 'skipped' AND decision = 'link')::int AS linked,
            count(*) FILTER (WHERE status = 'skipped')::int AS skipped
       FROM crm_cold_rows WHERE list_id = $1::bigint`,
    [listId],
  )) as { imported: number; linked: number; skipped: number }[];
  return {
    imported: Number(rows[0]?.imported ?? 0) || 0,
    linked: Number(rows[0]?.linked ?? 0) || 0,
    skipped: Number(rows[0]?.skipped ?? 0) || 0,
  };
}

export interface ColdDispositionPatch {
  disposition: ColdDisposition;
  note: string | null;
  callbackAt: Date | null;
  actorEmail: string;
  at: Date;
}

/**
 * Record one outcome and bump `touch_count` in the SAME statement, returning
 * the new count. That count is the activity row's dedupe key
 * (`coldrow:<id>:<n>`), so a double-tapped button writes one activity while
 * three genuine calls a week apart write three.
 *
 * `callback_at` is cleared unless this disposition sets one — a rep who said
 * "call in January" and then reached them must not leave a stale reminder.
 */
export async function setColdRowDisposition(
  rowId: string,
  patch: ColdDispositionPatch,
): Promise<ColdRowView | null> {
  if (!isDbConfigured()) return null;
  await ensureColdRowsSchema();
  const q = sql();
  const rows = (await q.query(
    `UPDATE crm_cold_rows
        SET disposition = $2, disposition_note = $3, callback_at = $4::timestamptz,
            disposition_by = $5, disposition_at = $6::timestamptz,
            touch_count = touch_count + 1,
            status = CASE WHEN status = 'skipped' THEN status ELSE 'ready' END,
            updated_at = NOW()
      WHERE id = $1::bigint
      RETURNING id::text AS id`,
    [
      rowId,
      patch.disposition,
      patch.note,
      patch.callbackAt ? patch.callbackAt.toISOString() : null,
      patch.actorEmail,
      patch.at.toISOString(),
    ],
  )) as { id: string }[];
  if (!rows[0]) return null;
  return getColdRow(rowId);
}

/** Point the row at the lead a conversion just created. */
export async function linkColdRowLead(
  rowId: string,
  leadId: string,
  contactId: string | null,
  accountId: string | null,
): Promise<ColdRowView | null> {
  if (!isDbConfigured()) return null;
  await ensureColdRowsSchema();
  const q = sql();
  await q.query(
    `UPDATE crm_cold_rows
        SET lead_id = $2::bigint,
            contact_id = COALESCE($3::bigint, contact_id),
            account_id = COALESCE($4::bigint, account_id),
            updated_at = NOW()
      WHERE id = $1::bigint`,
    [rowId, leadId, contactId, accountId],
  );
  return getColdRow(rowId);
}

/** Rows the review step shows: only the ones that matched something. */
export async function listColdMatches(listId: string, limit = 200): Promise<ColdRowView[]> {
  if (!isDbConfigured()) return [];
  await ensureColdRowsSchema();
  const q = sql();
  const rows = (await q.query(
    `SELECT ${ROW_SELECT} ${ROW_FROM}
      WHERE cr.list_id = $1::bigint AND cr.matched_by IS NOT NULL
      ORDER BY cr.row_index ASC, cr.id ASC
      LIMIT $2::int`,
    [listId, Math.min(Math.max(limit, 1), 500)],
  )) as ColdRowRaw[];
  return rows.map(mapColdRow);
}

export interface ColdRowTotals {
  rows: number;
  withPhone: number;
  withEmail: number;
  undialable: number;
  matched: number;
  duplicatesInFile: number;
  unreachable: number;
}

/** The import report's numbers, counted in the database rather than in memory. */
export async function coldRowTotals(listId: string): Promise<ColdRowTotals> {
  const zero: ColdRowTotals = {
    rows: 0,
    withPhone: 0,
    withEmail: 0,
    undialable: 0,
    matched: 0,
    duplicatesInFile: 0,
    unreachable: 0,
  };
  if (!isDbConfigured()) return zero;
  await ensureColdRowsSchema();
  const q = sql();
  const rows = (await q.query(
    `SELECT count(*)::int AS rows,
            count(*) FILTER (WHERE phone_e164 IS NOT NULL)::int AS with_phone,
            count(*) FILTER (WHERE email_key IS NOT NULL)::int AS with_email,
            count(*) FILTER (WHERE phone_raw IS NOT NULL AND phone_e164 IS NULL)::int AS undialable,
            count(*) FILTER (WHERE matched_by IS NOT NULL AND matched_by <> 'in_file')::int AS matched,
            count(*) FILTER (WHERE matched_by = 'in_file')::int AS duplicates_in_file,
            count(*) FILTER (WHERE phone_e164 IS NULL AND email_key IS NULL)::int AS unreachable
       FROM crm_cold_rows WHERE list_id = $1::bigint`,
    [listId],
  )) as {
    rows: number;
    with_phone: number;
    with_email: number;
    undialable: number;
    matched: number;
    duplicates_in_file: number;
    unreachable: number;
  }[];
  const r = rows[0];
  if (!r) return zero;
  return {
    rows: Number(r.rows) || 0,
    withPhone: Number(r.with_phone) || 0,
    withEmail: Number(r.with_email) || 0,
    undialable: Number(r.undialable) || 0,
    matched: Number(r.matched) || 0,
    duplicatesInFile: Number(r.duplicates_in_file) || 0,
    unreachable: Number(r.unreachable) || 0,
  };
}
