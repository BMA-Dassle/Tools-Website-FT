/**
 * The portal's KPI state buckets, reproduced exactly (brief §1.10).
 *
 * PURE — no Neon, no Office. The portal's own dashboard
 * (`api/sales/kpi-dashboard.ts`) decides which bucket a BMI project belongs to
 * from its STATE NAME, and this file must give the same answer for the same
 * name or the C7 smoke (every bucket within ±1 project of the portal for the
 * same month) is meaningless.
 *
 * Normalisation, in order: trim → drop a trailing parenthesised suffix
 * ("Deposit Requested (HPFM)" → "Deposit Requested") → lowercase → collapse
 * inner whitespace. A bucket matches on `===` OR `startsWith`, because Office
 * state names carry centre and waiver suffixes ("Confirmation + Waiver 2026").
 *
 * THE PORTAL DOUBLE-COUNTS "deposit requested": it is in QUOTED *and* in LEAD.
 * That is not a bug to fix here — LEAD is the conversion DENOMINATOR ("every
 * project that ever became a lead"), QUOTED is money still in play, and a
 * deposit-requested project is honestly both. `LEAD_STATES` keeps it so the
 * two dashboards agree; `isDoubleCounted` names the overlap so the smoke can
 * cite it when a number differs.
 */

/**
 * Strip a trailing "(...)" suffix and normalise case/whitespace.
 *
 * THE SECOND COPY of this, deliberately: `statuses/service/bmi-states.ts`
 * exports the same function, but that module imports the Office transport, and
 * this file must stay dependency-free so its test is pure. `buckets.test.ts`
 * asserts the two agree over a table of real Office state names.
 */
export function normalizeBmiStateName(raw: string | null | undefined): string {
  if (!raw) return "";
  return raw
    .replace(/\s*\([^)]*\)\s*$/, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

export const CONFIRMED_STATES = ["confirmation", "confirmation + waiver"] as const;

export const QUOTED_STATES = ["quote", "deposit requested"] as const;

export const LEAD_STATES = [
  "new lead",
  "contacted",
  "deposit requested",
  "quote",
  "confirmation",
  "confirmation + waiver",
  "cancellation",
] as const;

function hits(name: string, states: readonly string[]): boolean {
  return states.some((s) => name === s || name.startsWith(s));
}

export function isConfirmedState(stateName: string | null | undefined): boolean {
  return hits(normalizeBmiStateName(stateName), CONFIRMED_STATES);
}

export function isQuotedState(stateName: string | null | undefined): boolean {
  return hits(normalizeBmiStateName(stateName), QUOTED_STATES);
}

export function isLeadState(stateName: string | null | undefined): boolean {
  return hits(normalizeBmiStateName(stateName), LEAD_STATES);
}

export function isCancelledState(stateName: string | null | undefined): boolean {
  return normalizeBmiStateName(stateName).startsWith("cancellation");
}

/** True for the one state the portal counts in QUOTED and in LEAD at once. */
export function isDoubleCounted(stateName: string | null | undefined): boolean {
  return normalizeBmiStateName(stateName).startsWith("deposit requested");
}

/**
 * `"confirmation"` beats `"quote"` when a name somehow matches both (it cannot
 * today, but a renamed Office state could). `null` = the project is in none of
 * the portal's buckets and is excluded from every KPI figure.
 */
export function bucketOf(stateName: string | null | undefined): "confirmed" | "quoted" | null {
  if (isConfirmedState(stateName)) return "confirmed";
  if (isQuotedState(stateName)) return "quoted";
  return null;
}

/**
 * `round(confirmed / leads × 100)`, 0 when nothing has come in — the portal's
 * own formula, kept so the two dashboards print the same percentage.
 */
export function conversionRate(confirmed: number, leads: number): number {
  if (!leads) return 0;
  return Math.round((confirmed / leads) * 100);
}

/**
 * The portal's `totalRevenue` — confirmed PLUS quoted. NEVER label this
 * "revenue": nothing here has been collected. The screens say "booked + quoted".
 */
export function bookedPlusQuotedCents(confirmedCents: number, quotedCents: number): number {
  return confirmedCents + quotedCents;
}
