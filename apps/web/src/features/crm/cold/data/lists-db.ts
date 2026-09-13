/**
 * `crm_cold_lists` — an imported prospect list and who owns it (brief §3.8).
 * DDL only in PR1; C4/C6 add import.
 */

import { sql } from "@ft/db";
import { ensureRepsSchema } from "~/features/crm/reps";

let schemaReady: Promise<void> | null = null;

export function ensureColdListsSchema(): Promise<void> {
  schemaReady ??= (async () => {
    await ensureRepsSchema();
    const q = sql();
    await q`
      CREATE TABLE IF NOT EXISTS crm_cold_lists (
        id BIGSERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        owner_rep_id BIGINT REFERENCES crm_reps(id),
        source_filename TEXT,
        column_map JSONB,
        row_count INTEGER NOT NULL DEFAULT 0,
        imported_by TEXT,
        archived_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
  })();
  return schemaReady;
}
