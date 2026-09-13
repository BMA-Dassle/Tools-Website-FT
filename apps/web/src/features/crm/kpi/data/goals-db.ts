/**
 * `crm_goals` — monthly booked-revenue goals per rep (and optionally per
 * centre), mirroring the portal's `(rep, year, month, goal_cents)` shape (brief
 * §1.10). DDL only in PR1; C7 adds the Pandora goals sync.
 */

import { sql } from "@ft/db";
import { ensureRepsSchema } from "~/features/crm/reps";

let schemaReady: Promise<void> | null = null;

export function ensureGoalsSchema(): Promise<void> {
  schemaReady ??= (async () => {
    await ensureRepsSchema();
    const q = sql();
    await q`
      CREATE TABLE IF NOT EXISTS crm_goals (
        id BIGSERIAL PRIMARY KEY,
        rep_id BIGINT REFERENCES crm_reps(id),
        centre TEXT,
        year INTEGER NOT NULL,
        month INTEGER NOT NULL,
        goal_cents BIGINT NOT NULL DEFAULT 0,
        updated_by TEXT,
        pandora_synced_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (rep_id, centre, year, month)
      )
    `;
  })();
  return schemaReady;
}
