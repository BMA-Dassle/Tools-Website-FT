/**
 * `crm_assignments` — every hand-off of a lead, with the rule trace that
 * decided it (brief §3.8). DDL only in PR1; B2/B3 add the writers.
 */

import { sql } from "@ft/db";
import { ensureLeadsSchema } from "./leads-db";

let schemaReady: Promise<void> | null = null;

export function ensureAssignmentsSchema(): Promise<void> {
  schemaReady ??= (async () => {
    await ensureLeadsSchema();
    const q = sql();
    await q`
      CREATE TABLE IF NOT EXISTS crm_assignments (
        id BIGSERIAL PRIMARY KEY,
        lead_id BIGINT NOT NULL REFERENCES crm_leads(id),
        from_rep_id BIGINT,
        to_rep_id BIGINT,
        actor_email TEXT NOT NULL,
        reason TEXT NOT NULL CHECK (reason IN ('manual','auto','reassign','rule','release')),
        rule_id BIGINT,
        trace JSONB,
        note TEXT,
        bmi_responsible_synced_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
    await q`CREATE INDEX IF NOT EXISTS crm_assignments_lead ON crm_assignments (lead_id, created_at DESC)`;
  })();
  return schemaReady;
}
