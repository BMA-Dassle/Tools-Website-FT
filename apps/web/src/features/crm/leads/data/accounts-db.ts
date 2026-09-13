/**
 * `crm_accounts` — the business or household a lead belongs to (brief §3.8).
 * DDL only in PR1; B1/B3 add the readers and writers here.
 */

import { sql } from "@ft/db";

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
