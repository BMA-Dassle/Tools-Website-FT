/**
 * `crm_sms_messages` — every text, Neon first (R2): the row is `pending`
 * before `voxSend`, then `sent` / `failed` / `suppressed` with the provider id.
 * `(provider, provider_message_id)` is unique so a replayed status callback or
 * MO cannot double a row. DDL only in PR1; C1 adds the writers.
 */

import { sql } from "@ft/db";
import { ensureSmsThreadsSchema } from "./threads-db";

let schemaReady: Promise<void> | null = null;

export function ensureSmsMessagesSchema(): Promise<void> {
  schemaReady ??= (async () => {
    await ensureSmsThreadsSchema();
    const q = sql();
    await q`
      CREATE TABLE IF NOT EXISTS crm_sms_messages (
        id BIGSERIAL PRIMARY KEY,
        thread_id BIGINT NOT NULL REFERENCES crm_sms_threads(id),
        lead_id BIGINT,
        direction TEXT NOT NULL CHECK (direction IN ('in','out')),
        body TEXT NOT NULL,
        sent_from TEXT,
        provider TEXT,
        provider_message_id TEXT,
        delivery_status TEXT,
        delivery_error TEXT,
        send_status TEXT NOT NULL DEFAULT 'pending' CHECK (send_status IN ('pending','sent','failed','suppressed','received')),
        fallback_did BOOLEAN NOT NULL DEFAULT FALSE,
        template_id BIGINT,
        actor_email TEXT,
        occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
    await q`
      CREATE UNIQUE INDEX IF NOT EXISTS crm_sms_messages_provider
      ON crm_sms_messages (provider, provider_message_id)
      WHERE provider_message_id IS NOT NULL
    `;
    await q`CREATE INDEX IF NOT EXISTS crm_sms_messages_thread ON crm_sms_messages (thread_id, occurred_at DESC)`;
  })();
  return schemaReady;
}
