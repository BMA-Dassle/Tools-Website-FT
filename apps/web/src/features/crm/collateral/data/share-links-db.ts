/**
 * `crm_share_links` — a tokenised guest link to one collateral item (brief
 * §3.8), served by `app/api/crm/share/[token]` in C6. DDL only in PR1.
 */

import { sql } from "@ft/db";
import { ensureCollateralSchema } from "./collateral-db";

let schemaReady: Promise<void> | null = null;

export function ensureShareLinksSchema(): Promise<void> {
  schemaReady ??= (async () => {
    await ensureCollateralSchema();
    const q = sql();
    await q`
      CREATE TABLE IF NOT EXISTS crm_share_links (
        token TEXT PRIMARY KEY,
        collateral_id BIGINT NOT NULL REFERENCES crm_collateral(id),
        lead_id BIGINT,
        contact_id BIGINT,
        rep_id BIGINT,
        channel TEXT,
        opened_at TIMESTAMPTZ,
        open_count INTEGER NOT NULL DEFAULT 0,
        expires_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
  })();
  return schemaReady;
}
