/**
 * `crm_calls` — 3CX journal rows, reconciled call-control snapshots and
 * click-to-call intents (brief §3.8). `threecx_call_id` unique where present.
 * DDL only in PR1; C3 adds journal/reconcile/dispositions.
 */

import { sql } from "@ft/db";

let schemaReady: Promise<void> | null = null;

export function ensureCallsSchema(): Promise<void> {
  schemaReady ??= (async () => {
    const q = sql();
    await q`
      CREATE TABLE IF NOT EXISTS crm_calls (
        id BIGSERIAL PRIMARY KEY,
        threecx_call_id TEXT,
        direction TEXT NOT NULL CHECK (direction IN ('in','out')),
        from_e164 TEXT,
        to_e164 TEXT,
        extension TEXT,
        rep_id BIGINT,
        lead_id BIGINT,
        contact_id BIGINT,
        started_at TIMESTAMPTZ,
        answered_at TIMESTAMPTZ,
        ended_at TIMESTAMPTZ,
        duration_seconds INTEGER,
        status TEXT,
        disposition TEXT,
        disposition_note TEXT,
        recording_url TEXT,
        source TEXT NOT NULL CHECK (source IN ('journal','reconcile','manual','click')),
        actor_email TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
    await q`
      CREATE UNIQUE INDEX IF NOT EXISTS crm_calls_3cx ON crm_calls (threecx_call_id)
      WHERE threecx_call_id IS NOT NULL
    `;
    await q`CREATE INDEX IF NOT EXISTS crm_calls_lead ON crm_calls (lead_id, started_at DESC)`;
  })();
  return schemaReady;
}
