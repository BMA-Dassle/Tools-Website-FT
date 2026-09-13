/**
 * `crm_email_links` — a Graph message matched to a lead (brief §3.8), keyed
 * `(mailbox, graph_message_id)`. Store the IMMUTABLE id (`Prefer:
 * IdType="ImmutableId"` on the draft) or the sent copy will not match.
 * `crm_graph_subscriptions` — one row per (mailbox, folder). DDL only in PR1;
 * C2 adds the client, send, subscriptions, webhook and match.
 */

import { sql } from "@ft/db";

let schemaReady: Promise<void> | null = null;

export function ensureEmailSchema(): Promise<void> {
  schemaReady ??= (async () => {
    const q = sql();
    await q`
      CREATE TABLE IF NOT EXISTS crm_email_links (
        id BIGSERIAL PRIMARY KEY,
        mailbox TEXT NOT NULL,
        graph_message_id TEXT NOT NULL,
        conversation_id TEXT,
        internet_message_id TEXT,
        in_reply_to TEXT,
        lead_id BIGINT,
        contact_id BIGINT,
        rep_id BIGINT,
        direction TEXT NOT NULL CHECK (direction IN ('in','out')),
        subject TEXT,
        preview TEXT,
        from_email TEXT,
        to_emails TEXT[],
        sent_at TIMESTAMPTZ,
        matched_by TEXT,
        web_link TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (mailbox, graph_message_id)
      )
    `;
    await q`CREATE INDEX IF NOT EXISTS crm_email_links_lead ON crm_email_links (lead_id, sent_at DESC)`;
    await q`
      CREATE TABLE IF NOT EXISTS crm_graph_subscriptions (
        id BIGSERIAL PRIMARY KEY,
        mailbox TEXT NOT NULL,
        folder TEXT NOT NULL CHECK (folder IN ('inbox','sentitems')),
        subscription_id TEXT,
        client_state TEXT NOT NULL,
        expires_at TIMESTAMPTZ,
        status TEXT NOT NULL DEFAULT 'active',
        last_error TEXT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (mailbox, folder)
      )
    `;
  })();
  return schemaReady;
}
