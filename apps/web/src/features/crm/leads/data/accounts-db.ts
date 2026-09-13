/**
 * `crm_accounts` — the business or household a lead belongs to (brief §3.8).
 * DDL is PR1's; B3 adds the by-name upsert (B1 adds the mirror-driven one).
 *
 * `name_key` is the match key: lowercased, punctuation and legal suffixes
 * stripped, whitespace collapsed — "Lee Health — Cape Coral" and "lee health,
 * cape coral" are one account.
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
  })();
  return schemaReady;
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
  lifetime_cents: string | number;
  meta: unknown;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export function mapAccountRow(r: AccountRowRaw): CrmAccount {
  return {
    id: String(r.id),
    kind: r.kind === "household" ? "household" : "business",
    name: r.name,
    nameKey: r.name_key,
    centre: (r.centre as CentreCode | null) ?? null,
    lifetimeCents: Number(r.lifetime_cents) || 0,
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
  id::text AS id, kind, name, name_key, centre, lifetime_cents::text AS lifetime_cents, meta,
  ${ISO("archived_at")} AS archived_at,
  ${ISO("created_at")} AS created_at, ${ISO("updated_at")} AS updated_at
`;

/** Find by `name_key` (live rows first), else insert. Returns the row. */
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
    `SELECT ${COLUMNS} FROM crm_accounts WHERE name_key = $1
      ORDER BY (archived_at IS NULL) DESC, id ASC LIMIT 1`,
    [key],
  )) as AccountRowRaw[];
  if (existing[0]) return mapAccountRow(existing[0]);
  const rows = (await q.query(
    `INSERT INTO crm_accounts (kind, name, name_key, centre) VALUES ($1, $2, $3, $4)
     RETURNING ${COLUMNS}`,
    [input.kind, input.name.trim(), key, input.centre],
  )) as AccountRowRaw[];
  return rows[0] ? mapAccountRow(rows[0]) : null;
}

export async function getAccount(id: string): Promise<CrmAccount | null> {
  if (!isDbConfigured()) return null;
  await ensureAccountsSchema();
  const q = sql();
  const rows = (await q.query(`SELECT ${COLUMNS} FROM crm_accounts WHERE id = $1::bigint`, [
    id,
  ])) as AccountRowRaw[];
  return rows[0] ? mapAccountRow(rows[0]) : null;
}
