/**
 * `crm_sms_threads` — one conversation per (rep DID, guest number) (brief
 * §3.8). Rep DIDs live in `crm_reps.vox_did` ONLY (R8). DDL only in PR1; C1
 * adds send/inbound/threads.
 */

import { sql } from "@ft/db";
import { ensureRepsSchema } from "~/features/crm/reps";

let schemaReady: Promise<void> | null = null;

export function ensureSmsThreadsSchema(): Promise<void> {
  schemaReady ??= (async () => {
    await ensureRepsSchema();
    const q = sql();
    await q`
      CREATE TABLE IF NOT EXISTS crm_sms_threads (
        id BIGSERIAL PRIMARY KEY,
        rep_id BIGINT REFERENCES crm_reps(id),
        rep_did TEXT NOT NULL,
        guest_e164 TEXT NOT NULL,
        contact_id BIGINT,
        lead_id BIGINT,
        last_message_at TIMESTAMPTZ,
        last_inbound_at TIMESTAMPTZ,
        read_at TIMESTAMPTZ,
        unread_count INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (rep_did, guest_e164)
      )
    `;
  })();
  return schemaReady;
}
