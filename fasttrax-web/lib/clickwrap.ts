import { sql, isDbConfigured } from "@/lib/db";

/**
 * Clickwrap acceptance log — chargeback prevention.
 *
 * Every time a customer checks the policy agreement box and completes
 * payment, we write one row here. The record gives us a legally
 * defensible audit trail: timestamp, IP, user-agent, amount, card
 * details, and the exact policy version they agreed to.
 *
 * ── Why Postgres (not Redis) ─────────────────────────────────────
 * Chargeback disputes can surface months after a booking. Redis TTLs
 * would purge the evidence before we need it. Postgres keeps the
 * record indefinitely at trivial storage cost.
 *
 * ── Schema ──────────────────────────────────────────────────────
 * Auto-bootstrapped via ensureSchema() on first write.
 *
 * ── Policy versioning ───────────────────────────────────────────
 * Bump CURRENT_POLICY_VERSION whenever the displayed policy text
 * changes in a legally material way. Old rows retain the version
 * that was in effect at the time of acceptance.
 */

export const CURRENT_POLICY_VERSION = "v2-2026-04-30";

export interface ClickwrapAcceptance {
  /** ISO timestamp of acceptance (client-side, when button clicked). */
  ts: string;
  /** Server-captured IP address (from x-forwarded-for / x-real-ip). */
  ipAddress?: string;
  /** Browser user-agent string. */
  userAgent?: string;
  /** Policy version text the customer agreed to. */
  policyVersion: string;
  /** Contact email. */
  email?: string;
  /** Contact phone. */
  phone?: string;
  /** First name. */
  firstName?: string;
  /** BMI bill / order id. */
  billId?: string;
  /** Charge amount in cents (0 for credit-only orders). */
  amountCents?: number;
  /** Square card last-4 (populated after Square tokenizes). */
  cardLast4?: string;
  /** Square card brand (e.g. "Visa"). */
  cardBrand?: string;
  /** Booking type — "racing" | "racing-pack" etc. */
  bookingType?: string;
}

let schemaReady = false;
async function ensureSchema(): Promise<void> {
  if (schemaReady) return;
  if (!isDbConfigured()) return;
  const q = sql();
  await q`
    CREATE TABLE IF NOT EXISTS clickwrap_acceptances (
      id             SERIAL PRIMARY KEY,
      ts             TIMESTAMPTZ NOT NULL,
      ip_address     TEXT,
      user_agent     TEXT,
      policy_version TEXT NOT NULL,
      email          TEXT,
      phone          TEXT,
      first_name     TEXT,
      bill_id        TEXT,
      amount_cents   INTEGER,
      card_last4     TEXT,
      card_brand     TEXT,
      booking_type   TEXT,
      inserted_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await q`CREATE INDEX IF NOT EXISTS clickwrap_ts_idx     ON clickwrap_acceptances(ts DESC)`;
  await q`CREATE INDEX IF NOT EXISTS clickwrap_bill_idx   ON clickwrap_acceptances(bill_id) WHERE bill_id IS NOT NULL`;
  await q`CREATE INDEX IF NOT EXISTS clickwrap_email_idx  ON clickwrap_acceptances(email)   WHERE email IS NOT NULL`;
  schemaReady = true;
}

/**
 * Persist one clickwrap acceptance to Postgres.
 * Failures are logged + swallowed — must never break the payment flow.
 */
export async function logClickwrap(acceptance: ClickwrapAcceptance): Promise<void> {
  if (!isDbConfigured()) {
    console.warn("[clickwrap] DATABASE_URL not configured — skipping write");
    return;
  }
  try {
    await ensureSchema();
    const q = sql();
    await q`
      INSERT INTO clickwrap_acceptances (
        ts, ip_address, user_agent, policy_version,
        email, phone, first_name, bill_id,
        amount_cents, card_last4, card_brand, booking_type
      ) VALUES (
        ${acceptance.ts},
        ${acceptance.ipAddress ?? null},
        ${acceptance.userAgent ?? null},
        ${acceptance.policyVersion},
        ${acceptance.email ?? null},
        ${acceptance.phone ?? null},
        ${acceptance.firstName ?? null},
        ${acceptance.billId ?? null},
        ${acceptance.amountCents ?? null},
        ${acceptance.cardLast4 ?? null},
        ${acceptance.cardBrand ?? null},
        ${acceptance.bookingType ?? null}
      )
    `;
  } catch (err) {
    console.error("[clickwrap] write failed:", err);
  }
}
