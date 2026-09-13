/**
 * `crm_contacts` — a person we can reach (brief §3.8). `bmi_person_id` is TEXT
 * (17-digit Office ids). DDL only in PR1; B3 adds the writers.
 */

import { sql } from "@ft/db";
import { ensureAccountsSchema } from "./accounts-db";

let schemaReady: Promise<void> | null = null;

export function ensureContactsSchema(): Promise<void> {
  schemaReady ??= (async () => {
    await ensureAccountsSchema();
    const q = sql();
    await q`
      CREATE TABLE IF NOT EXISTS crm_contacts (
        id BIGSERIAL PRIMARY KEY,
        account_id BIGINT REFERENCES crm_accounts(id),
        first_name TEXT NOT NULL,
        last_name TEXT NOT NULL DEFAULT '',
        phone_e164 TEXT,
        email TEXT,
        email_key TEXT,
        bmi_person_id TEXT,
        prefers TEXT CHECK (prefers IN ('text','call','email')),
        meta JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
    await q`CREATE INDEX IF NOT EXISTS crm_contacts_phone ON crm_contacts (phone_e164)`;
    await q`CREATE INDEX IF NOT EXISTS crm_contacts_email ON crm_contacts (email_key)`;
  })();
  return schemaReady;
}
