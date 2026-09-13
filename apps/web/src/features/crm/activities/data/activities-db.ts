/**
 * `crm_activities` — the timeline (brief §3.8). One row per call / text /
 * email / note / status change; `(external_kind, external_ref)` is unique so a
 * replayed webhook never doubles an entry. Keyset pagination only (R10) —
 * hence the `(lead_id, occurred_at DESC)` index. DDL only in PR1.
 */

import { sql } from "@ft/db";
import { ensureLeadsSchema } from "~/features/crm/leads";

let schemaReady: Promise<void> | null = null;

export function ensureActivitiesSchema(): Promise<void> {
  schemaReady ??= (async () => {
    await ensureLeadsSchema();
    const q = sql();
    await q`
      CREATE TABLE IF NOT EXISTS crm_activities (
        id BIGSERIAL PRIMARY KEY,
        lead_id BIGINT REFERENCES crm_leads(id),
        contact_id BIGINT,
        rep_id BIGINT,
        actor_email TEXT,
        kind TEXT NOT NULL,
        direction TEXT,
        occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        duration_seconds INTEGER,
        outcome TEXT,
        subject TEXT,
        body TEXT,
        external_kind TEXT,
        external_ref TEXT,
        meta JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
    await q`CREATE INDEX IF NOT EXISTS crm_activities_lead ON crm_activities (lead_id, occurred_at DESC)`;
    await q`CREATE INDEX IF NOT EXISTS crm_activities_rep_week ON crm_activities (rep_id, occurred_at)`;
    await q`
      CREATE UNIQUE INDEX IF NOT EXISTS crm_activities_ext ON crm_activities (external_kind, external_ref)
      WHERE external_ref IS NOT NULL
    `;
  })();
  return schemaReady;
}
