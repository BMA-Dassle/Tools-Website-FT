/**
 * Race pricing primitives — tax math + price/total helpers + schedule
 * resolution. Pure functions, no I/O.
 *
 * Ports the slice of v1 `lib/packages.ts` + `app/book/race/data.ts` that
 * the v2 race flow actually needs:
 *
 *   - FL sales tax rate + calculate helpers
 *   - LICENSE_PRICE / POV_PRICE constants (used for upsell line items)
 *   - scheduleForDate(date) → "weekday" | "weekend" | "mega"
 *
 * Tier/category filtering moves to `race-products.ts`. Visual theming
 * (TIER_COLOR, TIER_DESCRIPTIONS) lives in `components/features/booking/
 * steps/race/*` when those components land in commit 9 — pricing math
 * stays vendor-neutral here.
 */

/** Schedule families (drive product filtering by day-of-week). */
export type Schedule = "weekday" | "weekend" | "mega";

/** Florida state sales tax — 6.5% on race line items. */
export const FL_TAX_RATE = 0.065;

/** Compute tax on a subtotal, rounded to the cent. */
export function calculateTax(subtotal: number): number {
  return Math.round(subtotal * FL_TAX_RATE * 100) / 100;
}

/** Compute total (subtotal + tax), rounded to the cent. */
export function calculateTotal(subtotal: number): number {
  return Math.round((subtotal + calculateTax(subtotal)) * 100) / 100;
}

/**
 * Resolve which BMI page / product set a given calendar date belongs to:
 *
 *   Tuesday (day 2)           → "mega"   (Mega Tuesday combined config)
 *   Friday / Saturday / Sunday → "weekend"
 *   Mon / Wed / Thu            → "weekday"
 *
 * Ports v1's `scheduleForDate` verbatim — the local-time construction
 * path avoids the UTC-parse trap where "2026-06-01" interpreted as UTC
 * lands on the wrong wall-clock day in US-East zones.
 *
 * Accepts a Date or an ISO-y string. Strings shaped `YYYY-MM-DD` (with
 * or without a trailing T-time) take the local-time path.
 */
export function scheduleForDate(d: Date | string): Schedule {
  let day: number;
  if (typeof d === "string") {
    const datePart = d.split("T")[0];
    const m = datePart.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (m) {
      // Local-time construction — sidesteps the UTC parse trap.
      day = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getDay();
    } else {
      day = new Date(d).getDay();
    }
  } else {
    day = d.getDay();
  }
  if (day === 2) return "mega";
  if (day === 0 || day === 5 || day === 6) return "weekend";
  return "weekday";
}

/**
 * License fee per first-time racer ("Starter" qualification line item).
 * Sourced from v1 `lib/packages.ts` LICENSE_PRICE constant.
 *
 * Applied PER PartyMember with `isNewRacer === true` who has at least
 * one race line assigned to them (the wizard's License step decides
 * who actually pays). Not applied to returning racers.
 */
export const LICENSE_PRICE = 4.99;

/**
 * Per-racer POV video purchase. Deferred to a future "video features"
 * PR (POV is NOT in PR-B2 scope per the v1_race_parity_checklist). The
 * constant is ported for forward-compat so race-pricing math doesn't
 * fork later.
 */
export const POV_PRICE = 5;
export const POV_CHECKIN_PRICE = 7;
