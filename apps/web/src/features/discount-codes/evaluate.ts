/**
 * Pure discount-code validation — NO DB, NO network, NO server-only imports.
 *
 * Split out of `service.ts` so it can be imported anywhere (including client
 * components and the booking-flow pricing helpers) without dragging the Neon
 * data layer (`./data` → `@ft/db`) into the bundle. `service.ts` re-exports
 * these for back-compat; tests import them from either path.
 *
 * `evaluateCode(row, ctx)` is the single source of truth for the rule set,
 * used by the public `/api/discount-codes/validate` endpoint, server-side
 * enforcement (quote/reserve), AND the booking-flow price reduction
 * (`features/booking/service/promo-pricing.ts`).
 */

import type {
  DiscountCodeRow,
  ValidateContext,
  ValidateResponse,
  ValidateResult,
  DiscountScopes,
  DiscountDomain,
} from "./types";

export const SUPPORTED_MECHANICS = new Set(["percent", "fixed"]);

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

  // Booking-DATE window: the VISIT date must fall in [start, end]. Distinct from
  // the purchase-time window above and from weekday — July 4 2026 is a Saturday,
  // so weekday alone would match every Saturday in the sale window. ISO
  // `YYYY-MM-DD` strings compare lexicographically, so no timezone math is needed
  // (unlike weekday, which needs etWeekday). Only enforced when a booking date is
  // provided — early/loose validation (landing page) skips it, same as weekday.
  if ((row.bookingDateStart || row.bookingDateEnd) && ctx.bookingDate) {
    if (row.bookingDateStart && ctx.bookingDate < row.bookingDateStart) {
      return { valid: false, reason: "wrong_date" };
    }
    if (row.bookingDateEnd && ctx.bookingDate > row.bookingDateEnd) {
      return { valid: false, reason: "wrong_date" };
    }
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

export function scopeIncludesDomain(scopes: DiscountScopes, domain: DiscountDomain): boolean {
  return Boolean((scopes as Record<string, unknown>)[domain]);
}

/** Every domain the row's `scopes` object touches — non-empty domain key = included. */
export function domainsFromScopes(scopes: DiscountScopes): DiscountDomain[] {
  const out: DiscountDomain[] = [];
  if (scopes.bowling) out.push("bowling");
  if (scopes.racing) out.push("racing");
  if (scopes.attractions) out.push("attractions");
  return out;
}

export function slugsForDomain(scopes: DiscountScopes, domain: DiscountDomain): string[] | null {
  if (domain === "bowling") return scopes.bowling?.experienceSlugs ?? null;
  if (domain === "racing") return scopes.racing?.productSlugs ?? null;
  if (domain === "attractions") return scopes.attractions?.slugs ?? null;
  return null;
}
