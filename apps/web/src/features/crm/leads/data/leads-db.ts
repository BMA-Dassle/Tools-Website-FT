/**
 * `crm_leads` — the pipeline row (brief §3.8). Neon FIRST: `capture_payload`
 * keeps the raw guest submission on every row (R2) and every BMI id is TEXT.
 * DDL only in PR1; B3 (`service/create-lead.ts`) adds the writers.
 *
 * `status_id` references `crm_statuses` with DEFAULT 'new', so the statuses
 * seed must exist before the first lead — `ensureCrmSchema()` seeds lazily.
 */

import { sql } from "@ft/db";
import { ensureRepsSchema } from "~/features/crm/reps";
import { ensureStatusesSchema } from "~/features/crm/statuses";
import { ensureAccountsSchema } from "./accounts-db";
import { ensureContactsSchema } from "./contacts-db";

let schemaReady: Promise<void> | null = null;

export function ensureLeadsSchema(): Promise<void> {
  schemaReady ??= (async () => {
    await ensureRepsSchema();
    await ensureStatusesSchema();
    await ensureAccountsSchema();
    await ensureContactsSchema();
    const q = sql();
    await q`
      CREATE TABLE IF NOT EXISTS crm_leads (
        id BIGSERIAL PRIMARY KEY,
        public_id TEXT NOT NULL UNIQUE,
        contact_id BIGINT REFERENCES crm_contacts(id),
        account_id BIGINT REFERENCES crm_accounts(id),
        centre TEXT NOT NULL,
        event_date DATE NOT NULL,
        event_time TIME,
        guests INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        source TEXT NOT NULL,
        is_prospect BOOLEAN NOT NULL DEFAULT FALSE,
        status_id TEXT NOT NULL REFERENCES crm_statuses(id) DEFAULT 'new',
        assigned_rep_id BIGINT REFERENCES crm_reps(id),
        assigned_at TIMESTAMPTZ,
        held_for_rep_id BIGINT REFERENCES crm_reps(id),
        first_touch_at TIMESTAMPTZ,
        next_action_kind TEXT,
        next_action_due TIMESTAMPTZ,
        next_action_label TEXT,
        value_cents BIGINT NOT NULL DEFAULT 0,
        lost_reason TEXT,
        notes TEXT,
        bmi_project_id TEXT,
        bmi_project_number TEXT,
        bmi_state_id TEXT,
        bmi_state_name TEXT,
        bmi_person_id TEXT,
        bmi_synced_at TIMESTAMPTZ,
        mint_status TEXT NOT NULL DEFAULT 'none' CHECK (mint_status IN ('none','pending','minted','failed')),
        mint_error TEXT,
        mint_attempts INTEGER NOT NULL DEFAULT 0,
        gf_short_id TEXT,
        last_year_bmi_project_id TEXT,
        cold_row_id BIGINT,
        capture_payload JSONB NOT NULL,
        created_by TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        archived_at TIMESTAMPTZ
      )
    `;
    await q`CREATE INDEX IF NOT EXISTS crm_leads_open ON crm_leads (status_id, assigned_rep_id, event_date)`;
    await q`CREATE INDEX IF NOT EXISTS crm_leads_bmi ON crm_leads (bmi_project_id)`;
    await q`
      CREATE INDEX IF NOT EXISTS crm_leads_queue ON crm_leads (created_at)
      WHERE assigned_rep_id IS NULL AND archived_at IS NULL
    `;
  })();
  return schemaReady;
}
