/**
 * `crm_shifts` — who is on today, mirrored from 7shifts or set by hand (brief
 * §3.8). `starts_at` / `ends_at` are TIMESTAMPTZ: 7shifts sends a local offset
 * and Postgres parses it (portal F1.10). DDL only in PR1; B2 adds the mirror.
 */

import { sql } from "@ft/db";
import { ensureRepsSchema } from "~/features/crm/reps";

let schemaReady: Promise<void> | null = null;

export function ensureShiftsSchema(): Promise<void> {
  schemaReady ??= (async () => {
    await ensureRepsSchema();
    const q = sql();
    await q`
      CREATE TABLE IF NOT EXISTS crm_shifts (
        id BIGSERIAL PRIMARY KEY,
        rep_id BIGINT NOT NULL REFERENCES crm_reps(id),
        shift_date DATE NOT NULL,
        starts_at TIMESTAMPTZ,
        ends_at TIMESTAMPTZ,
        source TEXT NOT NULL CHECK (source IN ('7shifts','manual')),
        seven_shifts_shift_id TEXT,
        location_id INTEGER,
        off_today BOOLEAN NOT NULL DEFAULT FALSE,
        off_reason TEXT,
        updated_by TEXT,
        synced_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (rep_id, shift_date, source, seven_shifts_shift_id)
      )
    `;
  })();
  return schemaReady;
}
