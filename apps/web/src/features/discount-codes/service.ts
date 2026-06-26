/**
 * Discount-code server surface: the AppliedPromo resolver + Square provisioning.
 *
 * Pure validation now lives in `./evaluate` (no DB / no network) so it can be
 * imported by client components and the booking-flow pricing helpers without
 * dragging the Neon data layer into the bundle. This file keeps the bits that
 * touch the outside world:
 *   1. `resolveAppliedPromo(code)` — fetch a row + project to the booking
 *      flow's `AppliedPromo` shape (DB read).
 *   2. `provisionSquareDiscount(row)` — POST to Square Catalog to create the
 *      corresponding DISCOUNT object (admin create/update + retry-provision).
 *
 * `evaluateCode` / `etWeekday` / `domainsFromScopes` are re-exported here for
 * back-compat; new code should import them from `./evaluate`.
 */

import type { AppliedPromo, DiscountCodeRow } from "./types";
import { getDiscountCodeByCode } from "./data";
import { SUPPORTED_MECHANICS, domainsFromScopes } from "./evaluate";

export { evaluateCode, etWeekday, domainsFromScopes } from "./evaluate";

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
 * Server-only: fetch a code by string and project to the v2 booking
 * `AppliedPromo` shape, treating any "unusable" reason (unknown,
 * inactive, expired, exhausted, unsupported mechanic) as a null
 * result. Anti-enumeration parity with `evaluateCode` — never leaks
 * whether the code exists.
 *
 * Note this is NOT scoped to a single domain — the landing page calls
 * this before the customer has picked an activity, so we return the
 * full multi-domain scope. Per-domain validation still happens at
 * checkout (via `evaluateCode`) for the same code.
 */
export async function resolveAppliedPromo(
  code: string,
  now: Date = new Date(),
): Promise<AppliedPromo | null> {
  const normalized = code.trim().toUpperCase();
  if (!normalized) return null;
  const row = await getDiscountCodeByCode(normalized);
  if (!row) return null;
  if (!row.active) return null;

  const start = new Date(row.startsAt).getTime();
  const expires = new Date(row.expiresAt).getTime();
  const nowMs = now.getTime();
  if (nowMs < start || nowMs >= expires) return null;

  if (row.maxUses != null && row.usesCount >= row.maxUses) return null;
  if (!SUPPORTED_MECHANICS.has(row.mechanic)) return null;

  return {
    code: row.code,
    domains: domainsFromScopes(row.scopes),
    scopes: row.scopes,
    startsAt: row.startsAt,
    expiresAt: row.expiresAt,
    allowedWeekdays: row.allowedWeekdays,
    bookingDateStart: row.bookingDateStart,
    bookingDateEnd: row.bookingDateEnd,
    // We rejected unsupported mechanics above so this narrowing is safe.
    mechanic: row.mechanic as "percent" | "fixed",
    amountPct: row.amountPct,
    amountCents: row.amountCents,
    squareCatalogId: row.squareCatalogId,
  };
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
