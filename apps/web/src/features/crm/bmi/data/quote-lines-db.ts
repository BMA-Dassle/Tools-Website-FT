/**
 * `crm_quote_lines` — the builder's intent rows (brief §3.8, R5): the Neon row
 * exists BEFORE the Office projectProduct write and records its verdict
 * (`write_status`, `office_prompt`). DDL only in PR1; C5 adds the builder.
 */

import { sql } from "@ft/db";
import { ensureLeadsSchema } from "~/features/crm/leads";

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
  })();
  return schemaReady;
}
