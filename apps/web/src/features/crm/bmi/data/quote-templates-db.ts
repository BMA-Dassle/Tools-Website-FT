/**
 * `crm_quote_templates` — reusable line sets for the builder (brief §3.8).
 * `lines` is `[{productId: string, per?: number, min?: number}]` — THE canonical
 * shape; qty = per ? max(min ?? 1, ceil(guests / per)) : (min ?? 1). DDL only
 * in PR1; C5 adds apply/scale.
 */

import { sql } from "@ft/db";

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
  })();
  return schemaReady;
}
