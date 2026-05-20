/**
 * Discount-code validation + Square catalog provisioning.
 *
 * Two responsibilities:
 *   1. `validateCode(ctx)` — the single source of truth used by the public
 *      `/api/discount-codes/validate` endpoint AND server-side enforcement
 *      paths (quote, reserve). Pure: given a row + context, returns
 *      valid/reason. No DB writes.
 *   2. `provisionSquareDiscount(row)` — POSTs to Square Catalog to create
 *      the corresponding DISCOUNT object. Only called from the admin
 *      create/update path and the retry-provision route.
 *
 * Pure validation is tested independently in service.test.ts so changes to
 * the rule set can be vetted without a live DB or Square account.
 */

import type {
  DiscountCodeRow,
  ValidateContext,
  ValidateResponse,
  ValidateResult,
  DiscountScopes,
  DiscountDomain,
} from "./types";

const SUPPORTED_MECHANICS = new Set(["percent", "fixed"]);

const SQUARE_BASE = "https://connect.squareup.com/v2";
const SQUARE_VERSION = "2024-12-18";

function sqHeaders() {
  return {
    Authorization: `Bearer ${process.env.SQUARE_ACCESS_TOKEN || ""}`,
    "Content-Type": "application/json",
    "Square-Version": SQUARE_VERSION,
  };
}

/**
 * Weekday in America/New_York for a YYYY-MM-DD date string.
 *
 * Bowling centers operate in ET, so "Mon–Thu" must be evaluated in the
 * customer's local zone — `new Date('2026-05-25').getDay()` would resolve
 * the date in UTC and silently lose a day at midnight ET.
 */
export function etWeekday(ymd: string): number {
  // Parse the YYYY-MM-DD as a date in ET by anchoring it to noon, which
  // avoids any DST cross-over ambiguity (noon ET is never near midnight UTC).
  const dt = new Date(`${ymd}T12:00:00-05:00`);
  const wd = dt.toLocaleDateString("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
  });
  const map: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return map[wd] ?? new Date(`${ymd}T12:00:00`).getDay();
}

/**
 * Pure validation. Returns `{ valid: true, ... }` or `{ valid: false, reason }`.
 *
 * Caller is responsible for fetching the row (or producing `null` for unknown
 * codes). Pure + sync = easy to test.
 */
export function evaluateCode(
  row: DiscountCodeRow | null,
  ctx: ValidateContext,
  now: Date = new Date(),
): ValidateResponse {
  if (!row) return { valid: false, reason: "unknown" };
  if (!row.active) return { valid: false, reason: "inactive" };

  // Date window
  const start = new Date(row.startsAt).getTime();
  const expires = new Date(row.expiresAt).getTime();
  const nowMs = now.getTime();
  if (nowMs < start) return { valid: false, reason: "not_yet_active" };
  if (nowMs >= expires) return { valid: false, reason: "expired" };

  // Mechanic supported?
  if (!SUPPORTED_MECHANICS.has(row.mechanic)) {
    return { valid: false, reason: "unsupported_mechanic" };
  }

  // Cap
  if (row.maxUses != null && row.usesCount >= row.maxUses) {
    return { valid: false, reason: "exhausted" };
  }

  // Location
  if (
    row.allowedLocations &&
    row.allowedLocations.length > 0 &&
    ctx.locationId &&
    !row.allowedLocations.includes(ctx.locationId)
  ) {
    return { valid: false, reason: "wrong_location" };
  }

  // Domain
  if (!scopeIncludesDomain(row.scopes, ctx.domain)) {
    return { valid: false, reason: "wrong_domain" };
  }

  // Product slug within domain
  if (ctx.productSlug) {
    const domainSlugs = slugsForDomain(row.scopes, ctx.domain);
    if (domainSlugs && !domainSlugs.includes(ctx.productSlug)) {
      return { valid: false, reason: "wrong_product" };
    }
  }

  // Weekday (only checked when a booking date was provided)
  if (
    ctx.bookingDate &&
    row.allowedWeekdays &&
    row.allowedWeekdays.length > 0 &&
    !row.allowedWeekdays.includes(etWeekday(ctx.bookingDate))
  ) {
    return { valid: false, reason: "wrong_weekday" };
  }

  const ok: ValidateResult = {
    valid: true,
    code: row.code,
    description: row.description,
    domain: ctx.domain,
    mechanic: row.mechanic,
    amountPct: row.amountPct,
    amountCents: row.amountCents,
    startsAt: row.startsAt,
    expiresAt: row.expiresAt,
    allowedWeekdays: row.allowedWeekdays,
    squareCatalogId: row.squareCatalogId,
  };
  return ok;
}

function scopeIncludesDomain(scopes: DiscountScopes, domain: DiscountDomain): boolean {
  return Boolean((scopes as Record<string, unknown>)[domain]);
}

function slugsForDomain(scopes: DiscountScopes, domain: DiscountDomain): string[] | null {
  if (domain === "bowling") return scopes.bowling?.experienceSlugs ?? null;
  if (domain === "racing") return scopes.racing?.productSlugs ?? null;
  if (domain === "attractions") return scopes.attractions?.slugs ?? null;
  return null;
}

// ─────────────────────────────────────────────────────────────────
// Square catalog provisioning
// ─────────────────────────────────────────────────────────────────

/**
 * Provision (or update) the Square Catalog DISCOUNT object that backs this
 * code. Only called when the code's scopes include `bowling` (the only
 * Square-native domain in v1). Returns the catalog id Square assigned.
 *
 * For percent codes we create a FIXED_PERCENTAGE discount. Square requires
 * `percentage` as a string with 1+ decimal places; "20" is rejected, "20.0"
 * works. Fixed-amount codes create a FIXED_AMOUNT discount with
 * `amount_money`. The two are mutually exclusive; mechanic_config-driven
 * BOGO (PRICING_RULE) is a future implementation.
 */
export async function provisionSquareDiscount(row: DiscountCodeRow): Promise<{
  catalogId: string;
}> {
  if (!process.env.SQUARE_ACCESS_TOKEN) {
    throw new Error("SQUARE_ACCESS_TOKEN is not set");
  }
  if (row.mechanic !== "percent" && row.mechanic !== "fixed") {
    throw new Error(`provisionSquareDiscount does not support mechanic=${row.mechanic}`);
  }

  // Match ops convention: "<Display Name> (<accounting code>)" e.g. "May Bowling 25% (500.02)".
  // Admin-supplied `squareDisplayName` wins; falls back to description, then the raw code.
  // The trailing parens carry the marketing/accounting reference if set, otherwise the
  // discount code itself so it's still cross-referenceable from the Square dashboard.
  const baseName = row.squareDisplayName ?? row.description ?? row.code;
  const refTag = row.marketingAccount ?? row.code;
  const friendlyName = `${baseName} (${refTag})`.slice(0, 255);

  const discount_data: Record<string, unknown> = {
    name: friendlyName,
    // MODIFY_TAX_BASIS makes the discount reduce the taxable basis as well —
    // so a "20% off" code reduces both the line subtotal AND the tax owed,
    // which matches what customers expect to see on the receipt.
    modify_tax_basis: "MODIFY_TAX_BASIS",
  };

  if (row.mechanic === "percent") {
    if (row.amountPct == null) throw new Error("amount_pct required for percent mechanic");
    discount_data.discount_type = "FIXED_PERCENTAGE";
    // Square requires a decimal string. Pad integers like 20 -> "20.00".
    discount_data.percentage = row.amountPct.toFixed(2);
  } else {
    if (row.amountCents == null) throw new Error("amount_cents required for fixed mechanic");
    discount_data.discount_type = "FIXED_AMOUNT";
    discount_data.amount_money = { amount: row.amountCents, currency: "USD" };
  }

  const body: Record<string, unknown> = {
    idempotency_key: `dc-${row.id}-${row.code}`.slice(0, 128),
    object: {
      type: "DISCOUNT",
      // When updating, pass the existing catalog id; otherwise use a `#`-prefixed
      // temp id that Square replaces in the response.
      id: row.squareCatalogId ?? `#dc-${row.id}`,
      discount_data,
    },
  };

  // If we're updating an existing catalog object, we must include its version.
  let version: number | undefined;
  if (row.squareCatalogId) {
    const getRes = await fetch(`${SQUARE_BASE}/catalog/object/${row.squareCatalogId}`, {
      headers: sqHeaders(),
    });
    if (getRes.ok) {
      const getData = await getRes.json();
      version = getData.object?.version;
    }
  }
  if (version != null) {
    (body.object as Record<string, unknown>).version = version;
  }

  const res = await fetch(`${SQUARE_BASE}/catalog/object`, {
    method: "POST",
    headers: sqHeaders(),
    body: JSON.stringify(body),
  });
  const data = await res.json();

  if (!res.ok || data.errors) {
    const err = data.errors?.[0];
    const detail = err ? `${err.code}: ${err.detail}` : JSON.stringify(data);
    throw new Error(`Square catalog provisioning failed: ${detail}`);
  }

  const catalogId: string | undefined = data.catalog_object?.id ?? data.id_mappings?.[0]?.object_id;
  if (!catalogId) {
    throw new Error("Square returned no catalog id");
  }
  return { catalogId };
}
