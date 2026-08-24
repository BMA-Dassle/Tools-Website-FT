import { sql, isDbConfigured } from "@ft/db";
import { ensureMarketingSchema } from "@/lib/marketing-db";
import type { SuppressionState } from "./suppression-policy";

/**
 * SMS suppression ledger — Neon, not Redis.
 *
 * Two tables, deliberately:
 *
 *  - `sms_consent_events` is APPEND-ONLY. Never updated, never deleted.
 *    It is the evidence.
 *  - `sms_suppression` is derived current state, for the send hot path.
 *    Rebuildable from the ledger at any time.
 *
 * ── Why append-only, when `marketing_consent` is one mutable row ─────
 *
 * `marketing_consent` upserts (`marketing-db.ts` ON CONFLICT DO UPDATE),
 * so opt out in March and back in in June and March is gone. We cannot
 * then prove what our state was on the day we sent any given message.
 * `64.1200(d)(6)` wants five years of that, and the TCPA limitations
 * period is four, so "what did we know and when" is the whole question in
 * any dispute.
 *
 * Postgres rather than Redis for the reason `lib/clickwrap.ts:12-15`
 * already states about chargebacks: TTLs would purge the evidence. That
 * applies with more force here — a Redis TTL quietly deleting a
 * suppression record risks re-adding the number and manufacturing a fresh
 * violation, which `64.1200(d)(6)` specifically guards against.
 *
 * ── Existing opt-outs are honored without a migration ───────────────
 *
 * `lookupSuppression` also reads `marketing_consent.opted_in = false`, so
 * the email-unsubscribe opt-outs already sitting in that table are
 * respected the moment the gate ships. No backfill, no window where a
 * previously-honored opt-out stops being honored.
 */

let schemaReady = false;

export async function ensureSmsConsentSchema(): Promise<void> {
  if (schemaReady) return;
  if (!isDbConfigured()) return;
  const q = sql();

  // ── The evidence. Append-only. ───────────────────────────────────
  await q`
    CREATE TABLE IF NOT EXISTS sms_consent_events (
      id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      ts                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      phone_e164          TEXT        NOT NULL,
      action              TEXT        NOT NULL,   -- 'opt_in' | 'opt_out'
      channel             TEXT        NOT NULL,   -- 'sms' | 'web' | 'staff' | 'email'
      source              TEXT        NOT NULL,   -- 'inbound_sms_stop' | 'staff' | ...
      reason              TEXT,
      -- Which exact on-screen copy was in front of the guest. Without
      -- this a consent record proves a click, not what was consented to.
      disclosure_version  TEXT,
      source_url          TEXT,
      ip_address          TEXT,
      user_agent          TEXT,
      person_id           TEXT,                   -- BMI id as TEXT, never a number
      signed_by_person_id TEXT,                   -- guardian attribution
      -- Provider message id for an SMS-originated event. UNIQUE, because
      -- Vox retries a non-2xx up to ~5 times and 64.1200(a)(12) allows
      -- exactly ONE confirmation per revocation.
      provider_message_id TEXT UNIQUE
    )
  `;
  await q`CREATE INDEX IF NOT EXISTS sce_phone_ts ON sms_consent_events(phone_e164, ts DESC)`;

  // ── Derived current state. Read on every send. ───────────────────
  await q`
    CREATE TABLE IF NOT EXISTS sms_suppression (
      phone_e164   TEXT        PRIMARY KEY,
      suppressed   BOOLEAN     NOT NULL,
      source       TEXT        NOT NULL,
      reason       TEXT,
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await q`
    CREATE INDEX IF NOT EXISTS sms_suppression_active
      ON sms_suppression(phone_e164) WHERE suppressed = TRUE
  `;

  schemaReady = true;
}

export interface ConsentEventInput {
  phoneE164: string;
  action: "opt_in" | "opt_out";
  channel: "sms" | "web" | "staff" | "email";
  source: string;
  reason?: string | null;
  disclosureVersion?: string | null;
  sourceUrl?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  personId?: string | null;
  signedByPersonId?: string | null;
  providerMessageId?: string | null;
}

/**
 * Append one consent event and move the derived current state.
 *
 * Returns `{ recorded: false }` when `providerMessageId` has already been
 * written — that is the idempotency guard, and the caller should treat it
 * as "already handled", NOT as an error. It is what stops a Vox retry
 * storm from sending five opt-out confirmations.
 *
 * The ledger insert and the state update run as one statement pair; the
 * ledger goes first so a failure between them leaves evidence without
 * state rather than state without evidence.
 */
export async function recordConsentEvent(
  input: ConsentEventInput,
): Promise<{ recorded: boolean; firstTime: boolean }> {
  if (!isDbConfigured()) return { recorded: false, firstTime: false };
  await ensureSmsConsentSchema();
  const q = sql();

  if (input.providerMessageId) {
    const dupe = await q`
      SELECT 1 FROM sms_consent_events
      WHERE provider_message_id = ${input.providerMessageId}
      LIMIT 1
    `;
    if (dupe.length > 0) return { recorded: false, firstTime: false };
  }

  await q`
    INSERT INTO sms_consent_events (
      phone_e164, action, channel, source, reason,
      disclosure_version, source_url, ip_address, user_agent,
      person_id, signed_by_person_id, provider_message_id
    ) VALUES (
      ${input.phoneE164}, ${input.action}, ${input.channel}, ${input.source},
      ${input.reason ?? null}, ${input.disclosureVersion ?? null},
      ${input.sourceUrl ?? null}, ${input.ipAddress ?? null},
      ${input.userAgent ?? null}, ${input.personId ?? null},
      ${input.signedByPersonId ?? null}, ${input.providerMessageId ?? null}
    )
    ON CONFLICT (provider_message_id) DO NOTHING
  `;

  const suppressed = input.action === "opt_out";
  const before = await q`
    SELECT suppressed FROM sms_suppression WHERE phone_e164 = ${input.phoneE164} LIMIT 1
  `;
  const wasSuppressed =
    before.length > 0 ? (before[0] as { suppressed: boolean }).suppressed : false;

  await q`
    INSERT INTO sms_suppression (phone_e164, suppressed, source, reason, updated_at)
    VALUES (${input.phoneE164}, ${suppressed}, ${input.source}, ${input.reason ?? null}, NOW())
    ON CONFLICT (phone_e164) DO UPDATE SET
      suppressed = EXCLUDED.suppressed,
      source     = EXCLUDED.source,
      reason     = EXCLUDED.reason,
      updated_at = NOW()
  `;

  // `firstTime` distinguishes a genuine state change from a repeat STOP.
  // A guest texting STOP twice gets ONE confirmation, per (a)(12).
  return { recorded: true, firstTime: suppressed !== wasSuppressed };
}

/**
 * Current suppression state for one number.
 *
 * Never throws — a thrown error on the send path would take down sends
 * entirely. Returns `lookupFailed` instead and lets `decideSend` apply
 * the fail-closed/fail-open rule per category.
 *
 * Deliberately uncached. A stale "not suppressed" is the one wrong answer
 * that costs money per message, and this is our own Neon rather than a
 * vendor API, so the round trip is cheap enough not to trade correctness
 * for it.
 */
export async function lookupSuppression(phoneE164: string): Promise<SuppressionState> {
  if (!isDbConfigured()) {
    // No database configured at all (local dev). Not a failure to read —
    // there is nothing to read, so nothing is suppressed.
    return { suppressed: false, lookupFailed: false };
  }
  try {
    await ensureSmsConsentSchema();
    // MUST run before the UNION below. On a database where nothing has
    // written marketing data yet, `marketing_consent` does not exist, the
    // query throws, `lookupFailed` goes true, and the fail-closed rule
    // then blocks EVERY transactional send. Both bootstraps memoize after
    // the first call, so this costs nothing steady-state.
    await ensureMarketingSchema();
    const q = sql();
    // One round trip covering the new ledger AND the pre-existing
    // marketing_consent opt-outs, so nothing already honored regresses.
    const rows = await q`
      SELECT TRUE AS blocked FROM sms_suppression
        WHERE phone_e164 = ${phoneE164} AND suppressed = TRUE
      UNION ALL
      SELECT TRUE AS blocked FROM marketing_consent
        WHERE phone_e164 = ${phoneE164} AND opted_in = FALSE
      LIMIT 1
    `;
    return { suppressed: rows.length > 0, lookupFailed: false };
  } catch (err) {
    console.error(`[sms-suppression] lookup failed for ${phoneE164}:`, err);
    return { suppressed: false, lookupFailed: true };
  }
}
