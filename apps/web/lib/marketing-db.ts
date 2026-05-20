import { sql, isDbConfigured } from "@ft/db";

/**
 * Marketing — cross-campaign Neon data layer.
 *
 * Tables:
 *   marketing_consent  — per-phone marketing opt-in / STOP registry
 *   marketing_touches  — per-customer per-campaign event log (sent / opened / clicked / converted / opted_out)
 *
 * These are SHARED across every marketing campaign (guest survey, future birthday
 * SMS, abandoned-cart, win-back, etc.). Campaign-specific tables live in their
 * own files (e.g. guest-survey-db.ts).
 *
 * Schema is auto-bootstrapped on first write via `ensureMarketingSchema()`.
 *
 * ── Why a separate table from sms_log ───────────────────────────────
 * sms_log (Redis, 90-day TTL) is transactional infrastructure: provider,
 * delivery status, retry state. marketing_touches is the *funnel* — what
 * we sent, who opened it, who converted. Marketing reporting reads from
 * here; ops debugging reads from sms_log.
 */

let schemaReady = false;

export async function ensureMarketingSchema(): Promise<void> {
  if (schemaReady) return;
  if (!isDbConfigured()) return;
  const q = sql();

  // ── marketing_consent ────────────────────────────────────────────
  // Default-deny for marketing: a phone with no row is treated as
  // "not opted in." Opt-in flips opted_in=true; STOP flips it to false.
  // Re-opt-in via START or admin tool updates the same row.
  await q`
    CREATE TABLE IF NOT EXISTS marketing_consent (
      phone_e164  TEXT        PRIMARY KEY,
      opted_in    BOOLEAN     NOT NULL,
      source      TEXT        NOT NULL,    -- 'booking_confirmation' | 'survey_completion' | 'admin' | 'inbound_sms_start' | 'inbound_sms_stop'
      reason      TEXT,                    -- free-text on opt-out: 'STOP reply', 'too many messages', etc.
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await q`CREATE INDEX IF NOT EXISTS mc_opted_in ON marketing_consent(opted_in) WHERE opted_in = TRUE`;

  // ── marketing_touches ────────────────────────────────────────────
  // One row per touch event. Backs both the per-campaign frequency cap
  // and analytics.
  //
  // event values:
  //   'sent'       — we sent a message
  //   'opened'     — recipient opened (e.g. first GET on a survey link)
  //   'clicked'    — recipient clicked through (e.g. /s/{code} hit)
  //   'converted'  — recipient completed the desired action (survey submitted, etc.)
  //   'opted_out'  — recipient sent STOP (also writes to marketing_consent)
  //   'skipped'    — we did NOT send (frequency cap, missing consent) — recorded for ops
  await q`
    CREATE TABLE IF NOT EXISTS marketing_touches (
      id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      customer_id  TEXT        NOT NULL,           -- Square customer id (source of truth)
      phone_e164   TEXT        NOT NULL,           -- denormalized for STOP-based lookups
      campaign     TEXT        NOT NULL,           -- 'guest_survey' | 'birthday' | ...
      channel      TEXT        NOT NULL DEFAULT 'sms',
      event        TEXT        NOT NULL,
      ref_id       TEXT,                            -- campaign-specific (survey token, reservation id, ...)
      meta_json    JSONB       NOT NULL DEFAULT '{}'::jsonb,
      occurred_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await q`CREATE INDEX IF NOT EXISTS mt_customer_campaign_sent ON marketing_touches(customer_id, campaign, occurred_at DESC) WHERE event = 'sent'`;
  await q`CREATE INDEX IF NOT EXISTS mt_campaign_event ON marketing_touches(campaign, event, occurred_at DESC)`;
  await q`CREATE INDEX IF NOT EXISTS mt_phone_opted_out ON marketing_touches(phone_e164) WHERE event = 'opted_out'`;

  schemaReady = true;
}

/**
 * Reset the schema-ready cache. Test-only — exported so vitest can force
 * a fresh bootstrap when running against a clean test schema.
 * @internal
 */
export function _resetMarketingSchemaCache(): void {
  schemaReady = false;
}

// ─────────────────────────────────────────────────────────────────
// marketing_consent helpers
// ─────────────────────────────────────────────────────────────────

export interface MarketingConsentRow {
  phoneE164: string;
  optedIn: boolean;
  source: string;
  reason: string | null;
  updatedAt: string;
}

function rowToConsent(row: Record<string, unknown>): MarketingConsentRow {
  return {
    phoneE164: row.phone_e164 as string,
    optedIn: row.opted_in as boolean,
    source: row.source as string,
    reason: (row.reason as string) ?? null,
    updatedAt: (row.updated_at as Date).toISOString(),
  };
}

export async function getMarketingConsent(phoneE164: string): Promise<MarketingConsentRow | null> {
  if (!isDbConfigured()) return null;
  await ensureMarketingSchema();
  const q = sql();
  const rows = await q`
    SELECT * FROM marketing_consent WHERE phone_e164 = ${phoneE164} LIMIT 1
  `;
  return rows.length ? rowToConsent(rows[0] as Record<string, unknown>) : null;
}

export async function upsertMarketingConsent(input: {
  phoneE164: string;
  optedIn: boolean;
  source: string;
  reason?: string | null;
}): Promise<void> {
  if (!isDbConfigured()) return;
  await ensureMarketingSchema();
  const q = sql();
  await q`
    INSERT INTO marketing_consent (phone_e164, opted_in, source, reason, updated_at)
    VALUES (${input.phoneE164}, ${input.optedIn}, ${input.source}, ${input.reason ?? null}, NOW())
    ON CONFLICT (phone_e164) DO UPDATE SET
      opted_in   = EXCLUDED.opted_in,
      source     = EXCLUDED.source,
      reason     = EXCLUDED.reason,
      updated_at = NOW()
  `;
}

// ─────────────────────────────────────────────────────────────────
// marketing_touches helpers
// ─────────────────────────────────────────────────────────────────

export type MarketingTouchEvent =
  | "sent"
  | "opened"
  | "clicked"
  | "converted"
  | "opted_out"
  | "skipped";

export interface MarketingTouchInput {
  customerId: string;
  phoneE164: string;
  campaign: string;
  channel?: string; // defaults to 'sms'
  event: MarketingTouchEvent;
  refId?: string | null;
  meta?: Record<string, unknown>;
}

export interface MarketingTouchRow extends Required<Omit<MarketingTouchInput, "meta">> {
  id: string;
  meta: Record<string, unknown>;
  occurredAt: string;
}

function rowToTouch(row: Record<string, unknown>): MarketingTouchRow {
  const rawMeta = row.meta_json;
  let meta: Record<string, unknown> = {};
  if (rawMeta && typeof rawMeta === "object") {
    meta = rawMeta as Record<string, unknown>;
  } else if (typeof rawMeta === "string") {
    try {
      meta = JSON.parse(rawMeta) as Record<string, unknown>;
    } catch {
      meta = {};
    }
  }
  return {
    id: row.id as string,
    customerId: row.customer_id as string,
    phoneE164: row.phone_e164 as string,
    campaign: row.campaign as string,
    channel: row.channel as string,
    event: row.event as MarketingTouchEvent,
    refId: (row.ref_id as string) ?? null,
    meta,
    occurredAt: (row.occurred_at as Date).toISOString(),
  };
}

export async function recordMarketingTouch(input: MarketingTouchInput): Promise<MarketingTouchRow> {
  if (!isDbConfigured()) throw new Error("DATABASE_URL not configured");
  await ensureMarketingSchema();
  const q = sql();
  const rows = await q`
    INSERT INTO marketing_touches (customer_id, phone_e164, campaign, channel, event, ref_id, meta_json)
    VALUES (
      ${input.customerId},
      ${input.phoneE164},
      ${input.campaign},
      ${input.channel ?? "sms"},
      ${input.event},
      ${input.refId ?? null},
      ${JSON.stringify(input.meta ?? {})}::jsonb
    )
    RETURNING *
  `;
  return rowToTouch(rows[0] as Record<string, unknown>);
}

/**
 * Hard-delete ALL marketing_touches rows for a phone within one campaign.
 * Test-only — used by the admin debug endpoint to clear prior 'sent'
 * touches so a force-retry isn't blocked by the 30-day cap.
 * Returns the count deleted.
 */
export async function deleteMarketingTouchesByPhone(opts: {
  phoneE164: string;
  campaign: string;
}): Promise<number> {
  if (!isDbConfigured()) return 0;
  await ensureMarketingSchema();
  const q = sql();
  const rows = await q`
    DELETE FROM marketing_touches
    WHERE phone_e164 = ${opts.phoneE164}
      AND campaign   = ${opts.campaign}
    RETURNING id
  `;
  return rows.length;
}

/**
 * Most-recent `sent` touch for (customer, campaign), or null if never sent.
 * Used by the frequency-cap check.
 */
export async function getLastSentTouch(opts: {
  customerId: string;
  campaign: string;
}): Promise<MarketingTouchRow | null> {
  if (!isDbConfigured()) return null;
  await ensureMarketingSchema();
  const q = sql();
  const rows = await q`
    SELECT * FROM marketing_touches
    WHERE customer_id = ${opts.customerId}
      AND campaign    = ${opts.campaign}
      AND event       = 'sent'
    ORDER BY occurred_at DESC
    LIMIT 1
  `;
  return rows.length ? rowToTouch(rows[0] as Record<string, unknown>) : null;
}
