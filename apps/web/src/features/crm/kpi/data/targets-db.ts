/**
 * `crm_targets` — per-rep weekly activity targets, effective-dated (brief §3.8).
 * DDL only in PR1; C7 adds accountability/pacing.
 */

import { sql } from "@ft/db";
import { ensureRepsSchema } from "~/features/crm/reps";

let schemaReady: Promise<void> | null = null;

export function ensureTargetsSchema(): Promise<void> {
  schemaReady ??= (async () => {
    await ensureRepsSchema();
    const q = sql();
    await q`
      CREATE TABLE IF NOT EXISTS crm_targets (
        id BIGSERIAL PRIMARY KEY,
        rep_id BIGINT NOT NULL REFERENCES crm_reps(id),
        effective_from DATE NOT NULL,
        calls INTEGER NOT NULL DEFAULT 0,
        texts INTEGER NOT NULL DEFAULT 0,
        emails INTEGER NOT NULL DEFAULT 0,
        reachouts INTEGER NOT NULL DEFAULT 0,
        response_target_minutes INTEGER NOT NULL DEFAULT 60,
        updated_by TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (rep_id, effective_from)
      )
    `;
  })();
  return schemaReady;
}
