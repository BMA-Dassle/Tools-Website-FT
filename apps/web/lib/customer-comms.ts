import { sql, isDbConfigured } from "@/lib/db";

/**
 * Durable customer-communications log — chargeback evidence.
 *
 * Every guest-facing email / SMS that carries policy or transaction context is
 * recorded here in Neon (NOT Redis — disputes surface months later, past any
 * TTL). Gives us defensible CARDHOLDER_COMMUNICATION evidence: what we sent, to
 * whom, when, which policy version was in effect, and the provider message id.
 *
 * Content lives in plain TEXT columns (subject/body) — queryable, not a blob.
 * NEVER stores card data: subject/body are redacted of any PAN-like digit run
 * before insert as a defense-in-depth guard (callers should never pass card
 * numbers, but we redact regardless).
 *
 * Soft-fail by design (like the clickwrap log): a logging failure must never
 * break the actual send.
 */

let schemaReady = false;

async function ensureSchema(): Promise<void> {
  if (schemaReady) return;
  const q = sql();
  await q`
    CREATE TABLE IF NOT EXISTS customer_communications (
      id                   SERIAL PRIMARY KEY,
      ts                   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      channel              TEXT NOT NULL,
      to_address           TEXT,
      subject              TEXT,
      body                 TEXT,
      policy_version       TEXT,
      reservation_ref      TEXT,
      kind                 TEXT,
      center               TEXT,
      provider             TEXT,
      provider_message_id  TEXT,
      status               TEXT,
      inserted_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;
  await q`CREATE INDEX IF NOT EXISTS cc_ts_idx ON customer_communications (ts DESC)`;
  await q`CREATE INDEX IF NOT EXISTS cc_ref_idx ON customer_communications (reservation_ref) WHERE reservation_ref IS NOT NULL`;
  await q`CREATE INDEX IF NOT EXISTS cc_channel_idx ON customer_communications (channel)`;
  schemaReady = true;
}

/**
 * Redact any PAN-like run of 13–19 digits (optionally space/hyphen separated)
 * so a card number can never be persisted, even if a caller passes one.
 */
export function redactCardLike(text: string | null | undefined): string | null {
  if (text == null) return null;
  // A leading digit followed by 12–18 more digits (each optionally preceded by a
  // single space/hyphen) = a 13–19 digit run → PAN-like. Short numbers
  // (reservation #, phone, last-4) have too few digits to match.
  return text.replace(/\d(?:[ -]?\d){12,18}/g, "[redacted]");
}

export interface CustomerComm {
  channel: "email" | "sms";
  toAddress?: string | null;
  subject?: string | null;
  body?: string | null;
  policyVersion?: string | null;
  reservationRef?: string | null;
  kind?: string | null;
  center?: string | null;
  provider?: string | null;
  providerMessageId?: string | null;
  status?: string | null;
}

export async function recordCustomerComm(comm: CustomerComm): Promise<void> {
  if (!isDbConfigured()) {
    console.warn("[customer-comms] DATABASE_URL not configured — skipping write");
    return;
  }
  try {
    await ensureSchema();
    const q = sql();
    await q`
      INSERT INTO customer_communications (
        channel, to_address, subject, body, policy_version,
        reservation_ref, kind, center, provider, provider_message_id, status
      ) VALUES (
        ${comm.channel},
        ${comm.toAddress ?? null},
        ${redactCardLike(comm.subject)},
        ${redactCardLike(comm.body)},
        ${comm.policyVersion ?? null},
        ${comm.reservationRef ?? null},
        ${comm.kind ?? null},
        ${comm.center ?? null},
        ${comm.provider ?? null},
        ${comm.providerMessageId ?? null},
        ${comm.status ?? null}
      )`;
  } catch (err) {
    console.error("[customer-comms] write failed:", err);
  }
}
