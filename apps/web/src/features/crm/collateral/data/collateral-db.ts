/**
 * `crm_collateral` — the files reps share (brief §3.8); bytes live in Blob,
 * the row carries the URL. DDL only in PR1; C6 adds upload/share.
 */

import { sql } from "@ft/db";

let schemaReady: Promise<void> | null = null;

export function ensureCollateralSchema(): Promise<void> {
  schemaReady ??= (async () => {
    const q = sql();
    await q`
      CREATE TABLE IF NOT EXISTS crm_collateral (
        id BIGSERIAL PRIMARY KEY,
        title TEXT NOT NULL,
        centre TEXT,
        type TEXT NOT NULL,
        blob_url TEXT NOT NULL,
        size_bytes BIGINT,
        tags TEXT[] NOT NULL DEFAULT '{}',
        valid_from DATE,
        valid_until DATE,
        shares INTEGER NOT NULL DEFAULT 0,
        uploaded_by TEXT,
        archived_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
  })();
  return schemaReady;
}
