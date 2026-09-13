/**
 * `crm_accounts` — the business or household a lead belongs to (brief §3.8).
 * DDL from PR1. B1 adds the upsert the BMI mirror links projects through, the
 * lifetime roll-up and the History readers; B3 adds the lead-side writers
 * (`accountNameKey` + `upsertAccountByName`, which match on the normalised
 * company name alone — a lead arrives with a typed name and no kind to key on).
 *
 * MATCHING KEY = `name_key` (`normalizeNameKey` in the bmi projection): a
 * business is one row per normalised company name; a household is
 * `household:<last name>:<phone digits | email | person:id>`, so two unrelated
 * Smiths never merge. `centre` is set on first sight and kept.
 *
 * `lifetime_cents` is a roll-up of the mirror's `total_value_cents` for the
 * account's non-cancelled group events; `refreshAccountLifetime` recomputes it
 * for the accounts a mirror run touched.
 */

import { isDbConfigured, sql } from "@ft/db";
import type { CentreCode, CrmAccount } from "../../core/types";
import { ISO } from "./sql";

let schemaReady: Promise<void> | null = null;

export function ensureAccountsSchema(): Promise<void> {
  schemaReady ??= (async () => {
    const q = sql();
    await q`
      CREATE TABLE IF NOT EXISTS crm_accounts (
        id BIGSERIAL PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('business','household')),
        name TEXT NOT NULL,
        name_key TEXT NOT NULL,
        centre TEXT,
        lifetime_cents BIGINT NOT NULL DEFAULT 0,
        meta JSONB,
        archived_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
    await q`CREATE INDEX IF NOT EXISTS crm_accounts_name_key ON crm_accounts (name_key)`;
    await ensureAccountKeyIndex();
  })();
  return schemaReady;
}

/**
 * `crm_accounts_kind_key` — the UNIQUE index `upsertAccountByKey`'s
 * `ON CONFLICT (kind, name_key)` needs (the BMI mirror finds-or-creates an
 * account for every project it reads).
 *
 * TWO THINGS THIS MUST NOT DO.
 *   1. `CREATE UNIQUE INDEX IF NOT EXISTS` does NOT skip the uniqueness check:
 *      if duplicate `(kind, name_key)` rows exist — rows the mirror could have
 *      written before this index did — it RAISES. So the duplicates are merged
 *      first, every time, before the index is attempted.
 *   2. It must never poison `ensureAccountsSchema`. That promise is memoised,
 *      so a rejection would be cached for the life of the lambda and every
 *      account READ would 500 until a cold start. A failure here is recorded
 *      and swallowed: reads keep working and only the upsert fails, loudly,
 *      with Postgres's own message.
 *
 * The table belongs to PR1 (§3.8: a later PR may only ADD COLUMN in its own
 * sub). Flagged to the lead — PR1 should own this index; until it does, this
 * is the safe way for B1 to depend on it.
 */
let accountKeyIndexError: string | null = null;

export function accountKeyIndexStatus(): string | null {
  return accountKeyIndexError;
}

async function ensureAccountKeyIndex(): Promise<void> {
  const q = sql();
  try {
    await mergeDuplicateAccountKeys();
    await q`CREATE UNIQUE INDEX IF NOT EXISTS crm_accounts_kind_key ON crm_accounts (kind, name_key)`;
    accountKeyIndexError = null;
  } catch (err) {
    accountKeyIndexError = err instanceof Error ? err.message : String(err);
    console.error(`[crm_accounts] unique key index not created: ${accountKeyIndexError}`);
  }
}

/**
 * Point every dependent row at the OLDEST account sharing a `(kind, name_key)`
 * and delete the rest. A no-op on a clean table (the common case), and the
 * dependents are only touched when their table exists.
 */
async function mergeDuplicateAccountKeys(): Promise<void> {
  const q = sql();
  const dupes = (await q`
    SELECT count(*)::int AS n
      FROM (SELECT 1 FROM crm_accounts GROUP BY kind, name_key HAVING count(*) > 1) d
  `) as { n?: number }[];
  if (!dupes[0]?.n) return;
  const winners = `
    SELECT a.id AS dupe_id, MIN(b.id) AS keep_id
      FROM crm_accounts a
      JOIN crm_accounts b ON b.kind = a.kind AND b.name_key = a.name_key
     GROUP BY a.id
    HAVING MIN(b.id) <> a.id
  `;
  for (const [table, column] of [
    ["crm_bmi_projects", "account_id"],
    ["crm_contacts", "account_id"],
    ["crm_leads", "account_id"],
  ] as const) {
    const exists = (await q.query(`SELECT to_regclass($1) IS NOT NULL AS ok`, [table])) as {
      ok: boolean;
    }[];
    if (!exists[0]?.ok) continue;
    await q.query(
      `UPDATE ${table} t SET ${column} = w.keep_id FROM (${winners}) w WHERE t.${column} = w.dupe_id`,
    );
  }
  await q.query(`DELETE FROM crm_accounts a USING (${winners}) w WHERE a.id = w.dupe_id`);
  console.warn("[crm_accounts] merged duplicate (kind, name_key) rows before the unique index");
}

const SUFFIXES = /\b(inc|llc|l\.l\.c|ltd|co|corp|corporation|company|pllc|pa|group)\b\.?/g;

/** "Lee Health — Cape Coral, LLC" → "lee health cape coral" */
export function accountNameKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/[’'`]/g, "")
    .replace(SUFFIXES, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export interface AccountRowRaw {
  id: string;
  kind: string;
  name: string;
  name_key: string;
  centre: string | null;
  lifetime_cents: string | number | null;
  meta: unknown;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

const CENTRES = new Set<CentreCode>(["HPFM", "FT", "HPN"]);

export function mapAccountRow(r: AccountRowRaw): CrmAccount {
  return {
    id: String(r.id),
    kind: r.kind === "household" ? "household" : "business",
    name: r.name,
    nameKey: r.name_key,
    centre: r.centre && CENTRES.has(r.centre as CentreCode) ? (r.centre as CentreCode) : null,
    lifetimeCents: Number(r.lifetime_cents ?? 0) || 0,
    meta:
      r.meta && typeof r.meta === "object" && !Array.isArray(r.meta)
        ? (r.meta as Record<string, unknown>)
        : null,
    archivedAt: r.archived_at ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const COLUMNS = `
  a.id::text AS id, a.kind, a.name, a.name_key, a.centre, a.lifetime_cents::text AS lifetime_cents, a.meta,
  ${ISO("a.archived_at")} AS archived_at,
  ${ISO("a.created_at")} AS created_at, ${ISO("a.updated_at")} AS updated_at
`;

export interface AccountUpsertInput {
  kind: "business" | "household";
  name: string;
  nameKey: string;
  centre: CentreCode | null;
}

/** Find-or-create by `(kind, name_key)`; the display name of an existing row is kept. */
export async function upsertAccountByKey(input: AccountUpsertInput): Promise<CrmAccount> {
  if (!isDbConfigured()) throw new Error("DATABASE_URL is not set");
  await ensureAccountsSchema();
  const q = sql();
  const rows = (await q.query(
    `INSERT INTO crm_accounts AS a (kind, name, name_key, centre)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (kind, name_key) DO UPDATE SET
       centre = COALESCE(a.centre, EXCLUDED.centre),
       updated_at = NOW()
     RETURNING ${COLUMNS}`,
    [input.kind, input.name.trim().slice(0, 200), input.nameKey, input.centre],
  )) as AccountRowRaw[];
  if (!rows[0]) throw new Error("crm_accounts: upsert returned no row");
  return mapAccountRow(rows[0]);
}

export async function getAccountById(id: string): Promise<CrmAccount | null> {
  if (!isDbConfigured() || !/^\d+$/.test(id)) return null;
  await ensureAccountsSchema();
  const q = sql();
  const rows = (await q.query(`SELECT ${COLUMNS} FROM crm_accounts a WHERE a.id = $1::bigint`, [
    id,
  ])) as AccountRowRaw[];
  return rows[0] ? mapAccountRow(rows[0]) : null;
}

/**
 * The lead-side find-or-create: match on `name_key` alone (live rows first),
 * else insert. A captured lead names a company; it does not say whether we
 * already filed that name as a household, so this must not key on `kind` —
 * and the insert takes the unique `(kind, name_key)` index B1 added into
 * account, so a race lands on the existing row instead of raising.
 */
export async function upsertAccountByName(input: {
  name: string;
  kind: "business" | "household";
  centre: CentreCode | null;
}): Promise<CrmAccount | null> {
  if (!isDbConfigured()) return null;
  const key = accountNameKey(input.name);
  if (!key) return null;
  await ensureAccountsSchema();
  const q = sql();
  const existing = (await q.query(
    `SELECT ${COLUMNS} FROM crm_accounts a WHERE a.name_key = $1
      ORDER BY (a.archived_at IS NULL) DESC, a.id ASC LIMIT 1`,
    [key],
  )) as AccountRowRaw[];
  if (existing[0]) return mapAccountRow(existing[0]);
  const rows = (await q.query(
    `INSERT INTO crm_accounts AS a (kind, name, name_key, centre) VALUES ($1, $2, $3, $4)
     ON CONFLICT (kind, name_key) DO UPDATE SET centre = COALESCE(a.centre, EXCLUDED.centre)
     RETURNING ${COLUMNS}`,
    [input.kind, input.name.trim(), key, input.centre],
  )) as AccountRowRaw[];
  return rows[0] ? mapAccountRow(rows[0]) : null;
}

/** The leads sub's name for {@link getAccountById} — one reader, two callers. */
export const getAccount = getAccountById;

/** Recompute `lifetime_cents` from the mirror for the given accounts. */
export async function refreshAccountLifetime(accountIds: readonly string[]): Promise<void> {
  const ids = [...new Set(accountIds.filter((x) => /^\d+$/.test(x)))];
  if (ids.length === 0 || !isDbConfigured()) return;
  await ensureAccountsSchema();
  const q = sql();
  await q.query(
    `UPDATE crm_accounts a
        SET lifetime_cents = COALESCE((
              SELECT SUM(p.total_value_cents) FROM crm_bmi_projects p
               WHERE p.account_id = a.id
                 AND p.kind_id IS DISTINCT FROM '-10'
                 AND p.state_id IS DISTINCT FROM '-4'
            ), 0),
            updated_at = NOW()
      WHERE a.id = ANY($1::bigint[])`,
    [ids],
  );
}

/** An account with the History list's roll-ups. */
export interface AccountSummary extends CrmAccount {
  eventCount: number;
  lastEventDate: string | null;
  /** Contact display names, most recently updated first. */
  contactNames: string[];
}

export interface AccountSummaryRaw extends AccountRowRaw {
  event_count: number | string | null;
  last_event_date: string | null;
  contact_names: string[] | null;
}

export function mapAccountSummary(r: AccountSummaryRaw): AccountSummary {
  return {
    ...mapAccountRow(r),
    eventCount: Number(r.event_count ?? 0) || 0,
    lastEventDate: r.last_event_date ? String(r.last_event_date).slice(0, 10) : null,
    contactNames: Array.isArray(r.contact_names) ? r.contact_names.filter(Boolean) : [],
  };
}

const SUMMARY_SELECT = `
  SELECT ${COLUMNS},
         (SELECT count(*) FROM crm_bmi_projects p WHERE p.account_id = a.id AND p.kind_id IS DISTINCT FROM '-10')::int AS event_count,
         (SELECT max(p.event_date) FROM crm_bmi_projects p WHERE p.account_id = a.id AND p.kind_id IS DISTINCT FROM '-10')::text AS last_event_date,
         (SELECT array_agg(DISTINCT trim(c.first_name || ' ' || c.last_name))
            FROM crm_contacts c
           WHERE c.account_id = a.id
              OR c.id IN (SELECT p.contact_id FROM crm_bmi_projects p
                           WHERE p.account_id = a.id AND p.contact_id IS NOT NULL)) AS contact_names
    FROM crm_accounts a
`;

/**
 * An account is worth listing once it has a mirrored event or a lead. Without
 * this an account the mirror created and then moved away from — the host of a
 * corporate booking who was first filed as a household, before the company
 * record was read — lingers as an empty row in the History list. The
 * `to_regclass` guard keeps this reader working before the leads sub's DDL has
 * run (only `crm_accounts` is ensured here).
 */
const HAS_SOMETHING = `
  (EXISTS (SELECT 1 FROM crm_bmi_projects p WHERE p.account_id = a.id)
   OR (to_regclass('crm_leads') IS NOT NULL
       AND EXISTS (SELECT 1 FROM crm_leads l WHERE l.account_id = a.id AND l.archived_at IS NULL)))
`;

export interface AccountSearchOpts {
  limit?: number;
  /** Keyset: the last row's id from the previous page. */
  cursor?: string | null;
}

/**
 * Accounts matching `q` by account name, contact name, phone digits or email
 * (an empty `q` lists the most recently active). Keyset on `id`.
 */
export async function searchAccounts(
  q: string,
  opts: AccountSearchOpts = {},
): Promise<{ items: AccountSummary[]; nextCursor: string | null }> {
  if (!isDbConfigured()) return { items: [], nextCursor: null };
  await ensureAccountsSchema();
  const sqlc = sql();
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const term = q.trim();
  const pattern = `%${term.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
  const digits = term.replace(/\D/g, "");
  const phoneDigits = digits.length >= 4 ? digits : "";
  const after = opts.cursor && /^\d+$/.test(opts.cursor) ? opts.cursor : null;
  const rows = (await sqlc.query(
    `${SUMMARY_SELECT}
      WHERE a.archived_at IS NULL
        AND ${HAS_SOMETHING}
        AND (
              $1::text = ''
           OR a.name ILIKE $2
           OR EXISTS (
                SELECT 1 FROM crm_contacts c
                 WHERE c.account_id = a.id
                   AND (
                         (c.first_name || ' ' || c.last_name) ILIKE $2
                      OR (c.email_key IS NOT NULL AND c.email_key LIKE lower($2))
                      OR ($3::text <> '' AND c.phone_e164 LIKE '%' || $3 || '%')
                   )
              )
        )
        AND ($4::bigint IS NULL OR a.id < $4::bigint)
      ORDER BY a.id DESC
      LIMIT $5`,
    [term, pattern, phoneDigits, after, limit + 1],
  )) as AccountSummaryRaw[];
  const items = rows.slice(0, limit).map(mapAccountSummary);
  const last = items[items.length - 1];
  return { items, nextCursor: rows.length > limit && last ? last.id : null };
}

export async function getAccountSummary(id: string): Promise<AccountSummary | null> {
  if (!isDbConfigured() || !/^\d+$/.test(id)) return null;
  await ensureAccountsSchema();
  const q = sql();
  const rows = (await q.query(`${SUMMARY_SELECT} WHERE a.id = $1::bigint`, [
    id,
  ])) as AccountSummaryRaw[];
  return rows[0] ? mapAccountSummary(rows[0]) : null;
}
