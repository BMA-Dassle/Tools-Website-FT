/**
 * Discount-codes Neon data layer.
 *
 * Schema is auto-bootstrapped on first write via `ensureDiscountCodesSchema()`,
 * mirroring the `bowling-db` pattern. All `CREATE … IF NOT EXISTS` and `ALTER
 * … ADD COLUMN IF NOT EXISTS` statements are idempotent.
 *
 * Tables:
 *   discount_codes        — one row per code (bowling/racing/attractions, all in one)
 *   discount_redemptions  — one row per successful charge that used a code
 *
 * Domain neutrality: this module never reaches into bowling/racing/attractions
 * specifics. It stores opaque JSONB `scopes` and a free-text `external_ref`.
 * The customer-flow callers know what their own ref/scope means.
 */

import { sql, isDbConfigured } from "@ft/db";
import type {
  DiscountCodeInput,
  DiscountCodeRow,
  DiscountDomain,
  DiscountMechanic,
  DiscountRedemptionRow,
  DiscountScopes,
  SquareCatalogType,
} from "./types";

let schemaReady = false;

export async function ensureDiscountCodesSchema(): Promise<void> {
  if (schemaReady) return;
  if (!isDbConfigured()) return;
  const q = sql();

  await q`
    CREATE TABLE IF NOT EXISTS discount_codes (
      id                      SERIAL  PRIMARY KEY,
      code                    TEXT    NOT NULL UNIQUE,
      description             TEXT,
      mechanic                TEXT    NOT NULL DEFAULT 'percent',
      amount_pct              NUMERIC(5,2),
      amount_cents            INTEGER,
      mechanic_config         JSONB,
      starts_at               TIMESTAMPTZ NOT NULL,
      expires_at              TIMESTAMPTZ NOT NULL,
      allowed_weekdays        SMALLINT[],
      allowed_locations       TEXT[],
      scopes                  JSONB   NOT NULL DEFAULT '{}'::JSONB,
      square_catalog_id       TEXT,
      square_catalog_type     TEXT,
      square_display_name     TEXT,
      marketing_account       TEXT,
      bmi_promo_ref           TEXT,
      max_uses                INTEGER,
      max_uses_per_customer   INTEGER,
      uses_count              INTEGER NOT NULL DEFAULT 0,
      active                  BOOLEAN NOT NULL DEFAULT TRUE,
      created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_by              TEXT
    )
  `;
  // Idempotent ALTERs for rows created before the columns existed.
  await q`ALTER TABLE discount_codes ADD COLUMN IF NOT EXISTS square_display_name TEXT`;
  await q`ALTER TABLE discount_codes ADD COLUMN IF NOT EXISTS marketing_account TEXT`;
  // Booking-DATE window (the VISIT date the code is valid for) — distinct from
  // the purchase-time window (starts_at/expires_at) and from allowed_weekdays.
  // A single-day holiday code (e.g. FREEDOM250 → 2026-07-04) sets both equal.
  await q`ALTER TABLE discount_codes ADD COLUMN IF NOT EXISTS booking_date_start DATE`;
  await q`ALTER TABLE discount_codes ADD COLUMN IF NOT EXISTS booking_date_end DATE`;
  await q`CREATE INDEX IF NOT EXISTS dc_active_window ON discount_codes(starts_at, expires_at) WHERE active = TRUE`;
  // Case-insensitive uniqueness — codes are uppercased on write but defend anyway.
  await q`CREATE UNIQUE INDEX IF NOT EXISTS dc_code_upper ON discount_codes(UPPER(code))`;

  await q`
    CREATE TABLE IF NOT EXISTS discount_redemptions (
      id                  SERIAL  PRIMARY KEY,
      code_id             INTEGER NOT NULL REFERENCES discount_codes(id),
      domain              TEXT    NOT NULL,
      external_ref        TEXT    NOT NULL,
      amount_off_cents    INTEGER NOT NULL DEFAULT 0,
      square_customer_id  TEXT,
      redeemed_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      refunded_at         TIMESTAMPTZ
    )
  `;
  // One redemption per external_ref per code — the reserve route can re-call
  // safely without double-incrementing the use counter.
  await q`CREATE UNIQUE INDEX IF NOT EXISTS dr_external_ref ON discount_redemptions(code_id, external_ref)`;
  await q`CREATE INDEX IF NOT EXISTS dr_domain_ref ON discount_redemptions(domain, external_ref)`;

  schemaReady = true;
}

// ─────────────────────────────────────────────────────────────────
// Row decoding
// ─────────────────────────────────────────────────────────────────

type RawDiscountRow = {
  id: number;
  code: string;
  description: string | null;
  mechanic: string;
  amount_pct: string | number | null;
  amount_cents: number | null;
  mechanic_config: Record<string, unknown> | null;
  starts_at: string | Date;
  expires_at: string | Date;
  allowed_weekdays: number[] | null;
  allowed_locations: string[] | null;
  booking_date_start: string | Date | null;
  booking_date_end: string | Date | null;
  scopes: DiscountScopes | null;
  square_catalog_id: string | null;
  square_catalog_type: string | null;
  square_display_name: string | null;
  marketing_account: string | null;
  bmi_promo_ref: string | null;
  max_uses: number | null;
  max_uses_per_customer: number | null;
  uses_count: number;
  active: boolean;
  created_at: string | Date;
  created_by: string | null;
};

function isoOrPassthrough(v: string | Date): string {
  return v instanceof Date ? v.toISOString() : v;
}

/** A DATE column → bare `YYYY-MM-DD` (drops any time/zone the driver attaches). */
function ymdOnly(v: string | Date): string {
  return (v instanceof Date ? v.toISOString() : v).slice(0, 10);
}

function decodeRow(r: RawDiscountRow): DiscountCodeRow {
  return {
    id: r.id,
    code: r.code,
    description: r.description,
    mechanic: r.mechanic as DiscountMechanic,
    amountPct: r.amount_pct == null ? null : Number(r.amount_pct),
    amountCents: r.amount_cents,
    mechanicConfig: r.mechanic_config,
    startsAt: isoOrPassthrough(r.starts_at),
    expiresAt: isoOrPassthrough(r.expires_at),
    allowedWeekdays: r.allowed_weekdays,
    allowedLocations: r.allowed_locations,
    bookingDateStart: r.booking_date_start ? ymdOnly(r.booking_date_start) : null,
    bookingDateEnd: r.booking_date_end ? ymdOnly(r.booking_date_end) : null,
    scopes: r.scopes ?? {},
    squareCatalogId: r.square_catalog_id,
    squareCatalogType: r.square_catalog_type as SquareCatalogType | null,
    squareDisplayName: r.square_display_name,
    marketingAccount: r.marketing_account,
    bmiPromoRef: r.bmi_promo_ref,
    maxUses: r.max_uses,
    maxUsesPerCustomer: r.max_uses_per_customer,
    usesCount: r.uses_count,
    active: r.active,
    createdAt: isoOrPassthrough(r.created_at),
    createdBy: r.created_by,
  };
}

// ─────────────────────────────────────────────────────────────────
// Queries
// ─────────────────────────────────────────────────────────────────

export async function listDiscountCodes(): Promise<DiscountCodeRow[]> {
  await ensureDiscountCodesSchema();
  const q = sql();
  const rows = (await q`
    SELECT * FROM discount_codes ORDER BY active DESC, created_at DESC
  `) as RawDiscountRow[];
  return rows.map(decodeRow);
}

export async function getDiscountCodeById(id: number): Promise<DiscountCodeRow | null> {
  await ensureDiscountCodesSchema();
  const q = sql();
  const rows = (await q`SELECT * FROM discount_codes WHERE id = ${id}`) as RawDiscountRow[];
  return rows[0] ? decodeRow(rows[0]) : null;
}

export async function getDiscountCodeByCode(code: string): Promise<DiscountCodeRow | null> {
  await ensureDiscountCodesSchema();
  const q = sql();
  const rows = (await q`
    SELECT * FROM discount_codes WHERE UPPER(code) = UPPER(${code})
  `) as RawDiscountRow[];
  return rows[0] ? decodeRow(rows[0]) : null;
}

export async function insertDiscountCode(
  input: DiscountCodeInput,
  createdBy: string,
): Promise<DiscountCodeRow> {
  await ensureDiscountCodesSchema();
  const q = sql();
  const scopesJson = JSON.stringify(input.scopes ?? {});
  const configJson = input.mechanicConfig ? JSON.stringify(input.mechanicConfig) : null;
  const rows = (await q`
    INSERT INTO discount_codes (
      code, description, mechanic, amount_pct, amount_cents, mechanic_config,
      starts_at, expires_at, allowed_weekdays, allowed_locations,
      booking_date_start, booking_date_end, scopes,
      square_display_name, marketing_account,
      max_uses, max_uses_per_customer, active, created_by
    ) VALUES (
      ${input.code.toUpperCase()},
      ${input.description ?? null},
      ${input.mechanic},
      ${input.amountPct ?? null},
      ${input.amountCents ?? null},
      ${configJson}::jsonb,
      ${input.startsAt},
      ${input.expiresAt},
      ${input.allowedWeekdays ?? null},
      ${input.allowedLocations ?? null},
      ${input.bookingDateStart ?? null},
      ${input.bookingDateEnd ?? null},
      ${scopesJson}::jsonb,
      ${input.squareDisplayName ?? null},
      ${input.marketingAccount ?? null},
      ${input.maxUses ?? null},
      ${input.maxUsesPerCustomer ?? null},
      ${input.active ?? true},
      ${createdBy}
    )
    RETURNING *
  `) as RawDiscountRow[];
  return decodeRow(rows[0]);
}

export async function updateDiscountCode(
  id: number,
  input: DiscountCodeInput,
): Promise<DiscountCodeRow | null> {
  await ensureDiscountCodesSchema();
  const q = sql();
  const scopesJson = JSON.stringify(input.scopes ?? {});
  const configJson = input.mechanicConfig ? JSON.stringify(input.mechanicConfig) : null;
  const rows = (await q`
    UPDATE discount_codes SET
      code = ${input.code.toUpperCase()},
      description = ${input.description ?? null},
      mechanic = ${input.mechanic},
      amount_pct = ${input.amountPct ?? null},
      amount_cents = ${input.amountCents ?? null},
      mechanic_config = ${configJson}::jsonb,
      starts_at = ${input.startsAt},
      expires_at = ${input.expiresAt},
      allowed_weekdays = ${input.allowedWeekdays ?? null},
      allowed_locations = ${input.allowedLocations ?? null},
      booking_date_start = ${input.bookingDateStart ?? null},
      booking_date_end = ${input.bookingDateEnd ?? null},
      scopes = ${scopesJson}::jsonb,
      square_display_name = ${input.squareDisplayName ?? null},
      marketing_account = ${input.marketingAccount ?? null},
      max_uses = ${input.maxUses ?? null},
      max_uses_per_customer = ${input.maxUsesPerCustomer ?? null},
      active = ${input.active ?? true}
    WHERE id = ${id}
    RETURNING *
  `) as RawDiscountRow[];
  return rows[0] ? decodeRow(rows[0]) : null;
}

export async function setSquareCatalog(
  id: number,
  catalogId: string,
  catalogType: SquareCatalogType,
): Promise<void> {
  await ensureDiscountCodesSchema();
  const q = sql();
  await q`
    UPDATE discount_codes
    SET square_catalog_id = ${catalogId},
        square_catalog_type = ${catalogType}
    WHERE id = ${id}
  `;
}

export async function setActive(id: number, active: boolean): Promise<void> {
  await ensureDiscountCodesSchema();
  const q = sql();
  await q`UPDATE discount_codes SET active = ${active} WHERE id = ${id}`;
}

/**
 * Atomic redemption: insert a redemption row AND bump uses_count in one
 * transaction-equivalent CTE. Returns the redemption row when both succeed,
 * `null` when the code's max_uses cap is full or the external_ref is a
 * duplicate (idempotent re-call).
 *
 * The ON CONFLICT DO NOTHING on (code_id, external_ref) means a reserve
 * route can safely re-call this after a transient failure without
 * double-incrementing.
 */
export async function recordRedemption(input: {
  codeId: number;
  domain: DiscountDomain;
  externalRef: string;
  amountOffCents: number;
  squareCustomerId?: string | null;
}): Promise<{ redemption: DiscountRedemptionRow | null; alreadyRedeemed: boolean }> {
  await ensureDiscountCodesSchema();
  const q = sql();

  // Two-step: try insert first; if a row was created, bump usage and return.
  // If no row was created the external_ref already exists OR the code was
  // exhausted (we check that after). Done as two statements rather than a
  // CTE because we want to surface the "exhausted vs duplicate" distinction.
  const inserted = (await q`
    INSERT INTO discount_redemptions (code_id, domain, external_ref, amount_off_cents, square_customer_id)
    VALUES (${input.codeId}, ${input.domain}, ${input.externalRef}, ${input.amountOffCents}, ${input.squareCustomerId ?? null})
    ON CONFLICT (code_id, external_ref) DO NOTHING
    RETURNING *
  `) as Array<{
    id: number;
    code_id: number;
    domain: string;
    external_ref: string;
    amount_off_cents: number;
    square_customer_id: string | null;
    redeemed_at: string | Date;
    refunded_at: string | Date | null;
  }>;

  if (inserted.length === 0) {
    return { redemption: null, alreadyRedeemed: true };
  }

  // Atomically bump uses_count only if we're under the cap. If the UPDATE
  // affects zero rows the code just exhausted — roll back the redemption.
  const updated = (await q`
    UPDATE discount_codes
    SET uses_count = uses_count + 1
    WHERE id = ${input.codeId}
      AND (max_uses IS NULL OR uses_count < max_uses)
    RETURNING uses_count
  `) as Array<{ uses_count: number }>;

  if (updated.length === 0) {
    // Cap was full — undo the redemption row to keep counters consistent.
    await q`DELETE FROM discount_redemptions WHERE id = ${inserted[0].id}`;
    return { redemption: null, alreadyRedeemed: false };
  }

  const r = inserted[0];
  return {
    redemption: {
      id: r.id,
      codeId: r.code_id,
      domain: r.domain as DiscountDomain,
      externalRef: r.external_ref,
      amountOffCents: r.amount_off_cents,
      squareCustomerId: r.square_customer_id,
      redeemedAt: isoOrPassthrough(r.redeemed_at),
      refundedAt: r.refunded_at ? isoOrPassthrough(r.refunded_at) : null,
    },
    alreadyRedeemed: false,
  };
}

/**
 * Idempotent refund: mark a redemption refunded AND decrement uses_count.
 * No-ops if the redemption doesn't exist or is already refunded.
 *
 * Lookup is by `external_ref` since refund flows know the bill/order ID,
 * not the discount-code's row id.
 */
export async function refundRedemption(
  domain: DiscountDomain,
  externalRef: string,
): Promise<boolean> {
  await ensureDiscountCodesSchema();
  const q = sql();

  const marked = (await q`
    UPDATE discount_redemptions
    SET refunded_at = NOW()
    WHERE domain = ${domain}
      AND external_ref = ${externalRef}
      AND refunded_at IS NULL
    RETURNING code_id
  `) as Array<{ code_id: number }>;

  if (marked.length === 0) return false;

  await q`
    UPDATE discount_codes
    SET uses_count = GREATEST(0, uses_count - 1)
    WHERE id = ${marked[0].code_id}
  `;
  return true;
}
