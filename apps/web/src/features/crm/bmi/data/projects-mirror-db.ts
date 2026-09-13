/**
 * `crm_bmi_projects` + `crm_bmi_sync_runs` — the read-only mirror of Office
 * projects (brief §3.8), the substrate for History & Accounts and the KPI
 * board. Every id column is TEXT; `raw` keeps the precision-safe parse of the
 * row as Office returned it. DDL only in PR1; B1 adds backfill + delta.
 */

import { sql } from "@ft/db";

let schemaReady: Promise<void> | null = null;

export function ensureBmiProjectsSchema(): Promise<void> {
  schemaReady ??= (async () => {
    const q = sql();
    await q`
      CREATE TABLE IF NOT EXISTS crm_bmi_projects (
        project_id TEXT PRIMARY KEY,
        client_key TEXT NOT NULL,
        location_id INTEGER,
        number TEXT,
        name TEXT,
        state_id TEXT,
        state_name TEXT,
        kind_id TEXT,
        responsible_user_id TEXT,
        responsible_name TEXT,
        event_date DATE,
        event_start TIMESTAMPTZ,
        persons INTEGER,
        total_value_cents BIGINT,
        balance_cents BIGINT,
        person_id TEXT,
        person_name TEXT,
        person_phone TEXT,
        person_email TEXT,
        products JSONB,
        raw JSONB,
        source TEXT NOT NULL CHECK (source IN ('backfill','delta','detail')),
        bmi_created_at TIMESTAMPTZ,
        bmi_updated_at TIMESTAMPTZ,
        synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
    await q`CREATE INDEX IF NOT EXISTS crm_bmi_projects_date ON crm_bmi_projects (client_key, event_date)`;
    await q`CREATE INDEX IF NOT EXISTS crm_bmi_projects_resp ON crm_bmi_projects (responsible_user_id, event_date)`;
    await q`CREATE INDEX IF NOT EXISTS crm_bmi_projects_phone ON crm_bmi_projects (person_phone)`;
    await q`
      CREATE TABLE IF NOT EXISTS crm_bmi_sync_runs (
        id BIGSERIAL PRIMARY KEY,
        client_key TEXT NOT NULL,
        kind TEXT NOT NULL,
        window_from TIMESTAMPTZ,
        window_until TIMESTAMPTZ,
        rows_seen INTEGER,
        rows_upserted INTEGER,
        ok BOOLEAN NOT NULL,
        error TEXT,
        started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        finished_at TIMESTAMPTZ
      )
    `;
  })();
  return schemaReady;
}
