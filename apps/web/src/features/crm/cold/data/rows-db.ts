/**
 * `crm_cold_rows` — one prospect per row, with its disposition (brief §3.8).
 * A cold row has NO SMS consent (R8): the composer offers Call / Email only
 * until an inbound message exists. DDL only in PR1.
 */

import { sql } from "@ft/db";
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
  })();
  return schemaReady;
}
