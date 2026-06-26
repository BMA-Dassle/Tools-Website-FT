/**
 * USA250-style promo price reduction — the single place the discount math
 * lives, shared by every display + charge seam so "displayed == charged".
 *
 * Mechanism (per owner): we OVERRIDE THE PRICE KEY — i.e. lower each eligible
 * line's amount to `(1 - pct/100) ×` its registry price. There is no Square
 * DISCOUNT object and no discount line item on the order; the order simply
 * carries the reduced price. The savings are surfaced to the guest by the
 * presentation layer (strikethrough + a savings line), driven off the
 * `originalAmount`/`promoPct` this helper stamps.
 *
 * All eligibility rules (domain / product slug / purchase-time window /
 * booking-date window) live in `evaluateCode` — this module only adapts the
 * session's `AppliedPromo` snapshot back into a row and asks. Pure: no DB, no
 * network, no `now`-at-module-load — safe in client and server bundles.
 *
 * Eligibility is decided PER LINE on the line's own `visitDate`, so a mixed
 * cart (a July-4 race + a July-6 bowling) discounts only the July-4 line.
 */

import { evaluateCode } from "~/features/discount-codes/evaluate";
import type { AppliedPromo, DiscountCodeRow, DiscountDomain } from "~/features/discount-codes";

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Per-line context the eligibility check needs. */
export interface PromoLineCtx {
  domain: DiscountDomain;
  /** YYYY-MM-DD the line is for; gates the booking-date window. */
  visitDate?: string | null;
  /** Product slug, for slug-scoped codes. Omit for all-products codes. */
  productSlug?: string | null;
}

export interface PromoOpts {
  /** Defaults to `new Date()` — pass a fixed value in tests. */
  now?: Date;
  locationId?: string;
}

export interface PromoOutcome {
  /** Reduced amount (rounded to the cent) — equals `original` when not applied. */
  amount: number;
  /** The pre-promo amount. */
  originalAmount: number;
  /** Cents removed (for the redemption ledger). */
  amountOffCents: number;
  applied: boolean;
}

/**
 * Adapt the session's `AppliedPromo` snapshot back into the shape `evaluateCode`
 * expects. The snapshot can't carry live `usesCount` (it was taken at session
 * start), so the cap is NOT re-checked here — it is authoritatively enforced at
 * charge time by `recordRedemption`. Everything else (window, domain, slug,
 * booking-date) is real.
 */
function appliedPromoToRow(p: AppliedPromo): DiscountCodeRow {
  return {
    id: 0,
    code: p.code,
    description: null,
    mechanic: p.mechanic,
    amountPct: p.amountPct,
    amountCents: p.amountCents,
    mechanicConfig: null,
    startsAt: p.startsAt,
    expiresAt: p.expiresAt,
    allowedWeekdays: p.allowedWeekdays,
    allowedLocations: null,
    bookingDateStart: p.bookingDateStart,
    bookingDateEnd: p.bookingDateEnd,
    scopes: p.scopes,
    squareCatalogId: p.squareCatalogId,
    squareCatalogType: null,
    squareDisplayName: null,
    marketingAccount: null,
    bmiPromoRef: null,
    maxUses: null,
    maxUsesPerCustomer: null,
    usesCount: 0,
    active: true,
    createdAt: p.startsAt,
    createdBy: null,
  };
}

/** Is this line eligible for the promo? All rules live in `evaluateCode`. */
export function isPromoEligibleLine(
  ctx: PromoLineCtx,
  promo: AppliedPromo | null,
  opts: PromoOpts = {},
): boolean {
  if (!promo) return false;
  // Fail CLOSED at the price seam: a date-scoped code must not discount a line
  // whose visit date we couldn't read. (evaluateCode deliberately SKIPS the
  // booking-date check when no date is given — that's for loose landing-page
  // validation; here a missing date means "don't apply", not "apply anyway".)
  if ((promo.bookingDateStart || promo.bookingDateEnd) && !ctx.visitDate) return false;
  const res = evaluateCode(
    appliedPromoToRow(promo),
    {
      code: promo.code,
      domain: ctx.domain,
      productSlug: ctx.productSlug ?? undefined,
      bookingDate: ctx.visitDate ?? undefined,
      locationId: opts.locationId,
    },
    opts.now,
  );
  return res.valid;
}

/**
 * Multiplicative price factor for an eligible PERCENT promo (e.g. 0.75 for 25%
 * off), else 1. Callers working in integer cents use this:
 * `Math.round(unitCents * promoFactor(...))`.
 *
 * Fixed-amount codes return 1 here — a per-line price-key reduction can't
 * meaningfully spread a flat $-amount across a multi-line cart, and the live
 * USA250 code is percent. Fixed codes keep their existing behavior.
 */
export function promoFactor(
  ctx: PromoLineCtx,
  promo: AppliedPromo | null,
  opts: PromoOpts = {},
): number {
  if (!promo || promo.mechanic !== "percent" || promo.amountPct == null) return 1;
  if (!isPromoEligibleLine(ctx, promo, opts)) return 1;
  return 1 - promo.amountPct / 100;
}

/** Reduce a single dollar-denominated amount (e.g. a `BillLine.amount`). */
export function applyPromoToAmount(
  amount: number,
  ctx: PromoLineCtx,
  promo: AppliedPromo | null,
  opts: PromoOpts = {},
): PromoOutcome {
  const factor = promoFactor(ctx, promo, opts);
  if (factor === 1) {
    return { amount, originalAmount: amount, amountOffCents: 0, applied: false };
  }
  const reduced = round2(amount * factor);
  return {
    amount: reduced,
    originalAmount: amount,
    amountOffCents: Math.round((amount - reduced) * 100),
    applied: true,
  };
}

/**
 * The minimal line shape `applyPromoToBillLines` needs. `BillLine`
 * (features/booking/service/checkout) satisfies this structurally, so this
 * module never has to import from checkout.ts (avoids a circular import).
 */
export interface PromoableLine {
  amount: number;
  domain?: DiscountDomain | null;
  visitDate?: string | null;
  productSlug?: string | null;
  /** Stamped when reduced — also the idempotency guard (see below). */
  originalAmount?: number;
  promoPct?: number;
}

/**
 * Reduce every eligible line in a list, stamping `originalAmount`/`promoPct` so
 * the UI can render "was $X → now $Y". IDEMPOTENT: a line that already carries
 * `originalAmount` is left untouched, so this can be called at more than one
 * assembly point (e.g. inside `buildRaceChargeLines` AND again over the merged
 * overview lines) without double-discounting.
 *
 * A line with no `domain` (e.g. license/POV/fees that aren't promo-scoped) is
 * skipped.
 */
export function applyPromoToBillLines<T extends PromoableLine>(
  lines: T[],
  promo: AppliedPromo | null,
  opts: PromoOpts = {},
): T[] {
  if (!promo) return lines;
  return lines.map((line) => {
    if (line.originalAmount != null) return line; // already discounted — idempotent
    if (!line.domain) return line;
    const outcome = applyPromoToAmount(
      line.amount,
      { domain: line.domain, visitDate: line.visitDate, productSlug: line.productSlug },
      promo,
      opts,
    );
    if (!outcome.applied) return line;
    return {
      ...line,
      amount: outcome.amount,
      originalAmount: outcome.originalAmount,
      promoPct: promo.amountPct ?? undefined,
    };
  });
}

/** Total cents removed across a set of (already-discounted) lines — for the ledger. */
export function promoSavingsCents(lines: PromoableLine[]): number {
  return lines.reduce(
    (sum, l) =>
      sum + (l.originalAmount != null ? Math.round((l.originalAmount - l.amount) * 100) : 0),
    0,
  );
}
