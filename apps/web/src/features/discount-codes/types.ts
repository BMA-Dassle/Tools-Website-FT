/**
 * Discount-code feature types.
 *
 * The system is cross-domain by design — a single `discount_codes` row can
 * apply to bowling, racing, or attractions (or any combination). Each
 * customer-facing flow plugs into the shared `validateCode()` service and
 * passes its own domain identifier.
 *
 * Future mechanics (BOGO, free-addon, tiered) are accepted by the schema and
 * type union, but `validateCode()` will reject them until those code paths
 * are built. See [restructure-plan.md] and the discount-codes plan for the
 * upgrade path.
 */

/** Booking domain identifiers a code can scope itself to. */
export type DiscountDomain = "bowling" | "racing" | "attractions";

/**
 * Discount mechanic. Only `percent` and `fixed` are honored in v1;
 * `bogo` and `free_addon` are schema-ready but rejected by validate.
 */
export type DiscountMechanic = "percent" | "fixed" | "bogo" | "free_addon";

/** Which Square Catalog object type backs this code (when applicable). */
export type SquareCatalogType = "discount" | "pricing_rule";

/**
 * Per-domain scope. Top-level key presence = code applies to that domain.
 * Inner array `null` = "all products in that domain"; a non-null array
 * restricts to those specific slugs.
 */
export interface DiscountScopes {
  bowling?: { experienceSlugs: string[] | null };
  racing?: { productSlugs: string[] | null };
  attractions?: { slugs: string[] | null };
}

/** Raw DB row shape. Camel-cased fields, decoded from snake_case columns. */
export interface DiscountCodeRow {
  id: number;
  code: string;
  description: string | null;
  mechanic: DiscountMechanic;
  amountPct: number | null;
  amountCents: number | null;
  mechanicConfig: Record<string, unknown> | null;
  startsAt: string;
  expiresAt: string;
  allowedWeekdays: number[] | null;
  allowedLocations: string[] | null;
  /**
   * Booking-DATE window (the VISIT date the code is valid for), `YYYY-MM-DD`.
   * Distinct from the purchase-time window (`startsAt`/`expiresAt`) and from
   * `allowedWeekdays`. `null` = no booking-date restriction. A single-day
   * holiday code sets both equal (e.g. FREEDOM250 → `2026-07-04`).
   */
  bookingDateStart: string | null;
  bookingDateEnd: string | null;
  scopes: DiscountScopes;
  squareCatalogId: string | null;
  squareCatalogType: SquareCatalogType | null;
  /**
   * Display name written to Square's catalog. Composed with `marketingAccount`
   * at provision time to match the in-house convention ("May Bowling 25% (500.02)").
   * Falls back to `description` then `code` when not set.
   */
  squareDisplayName: string | null;
  /**
   * Accounting code shown in parentheses on the Square name (e.g. "500.02").
   * Free-form string — ops decides the numbering scheme.
   */
  marketingAccount: string | null;
  bmiPromoRef: string | null;
  maxUses: number | null;
  maxUsesPerCustomer: number | null;
  usesCount: number;
  active: boolean;
  createdAt: string;
  createdBy: string | null;
}

/** Input shape for creating or updating a discount code. */
export interface DiscountCodeInput {
  code: string;
  description?: string;
  mechanic: DiscountMechanic;
  amountPct?: number | null;
  amountCents?: number | null;
  mechanicConfig?: Record<string, unknown> | null;
  startsAt: string;
  expiresAt: string;
  allowedWeekdays?: number[] | null;
  allowedLocations?: string[] | null;
  /** Booking-date window (visit date), `YYYY-MM-DD`; `null`/omitted = no restriction. */
  bookingDateStart?: string | null;
  bookingDateEnd?: string | null;
  scopes: DiscountScopes;
  squareDisplayName?: string | null;
  marketingAccount?: string | null;
  maxUses?: number | null;
  maxUsesPerCustomer?: number | null;
  active?: boolean;
}

/** Reasons a code can be rejected at validation time. */
export type ValidateReason =
  | "unknown"
  | "inactive"
  | "not_yet_active"
  | "expired"
  | "exhausted"
  | "wrong_location"
  | "wrong_domain"
  | "wrong_product"
  | "wrong_weekday"
  | "wrong_date"
  | "unsupported_mechanic"
  | "rate_limited";

/** Context the customer flow provides when validating a code. */
export interface ValidateContext {
  code: string;
  domain: DiscountDomain;
  locationId?: string;
  productSlug?: string;
  /** YYYY-MM-DD of the booking date (used for weekday + window checks). */
  bookingDate?: string;
}

/** Successful validate response (returned to the customer flow). */
export interface ValidateResult {
  valid: true;
  code: string;
  description: string | null;
  domain: DiscountDomain;
  mechanic: DiscountMechanic;
  amountPct: number | null;
  amountCents: number | null;
  startsAt: string;
  expiresAt: string;
  /** Allowed weekdays as 0–6 (Sun=0). `null` means any weekday. */
  allowedWeekdays: number[] | null;
  /** Square Catalog DISCOUNT id, when this code applies to a Square-native domain (bowling). */
  squareCatalogId: string | null;
}

export type ValidateFailure = { valid: false; reason: ValidateReason };

export type ValidateResponse = ValidateResult | ValidateFailure;

/** A single redemption record (one row per successful charge using the code). */
export interface DiscountRedemptionRow {
  id: number;
  codeId: number;
  domain: DiscountDomain;
  externalRef: string;
  amountOffCents: number;
  squareCustomerId: string | null;
  redeemedAt: string;
  refundedAt: string | null;
}

/**
 * The shape v2 booking captures at session start — a snapshot of the
 * usable bits of a `DiscountCodeRow`, projected for the booking flow.
 *
 * Set once on `session.appliedPromo` at the start of a session (via
 * the `/book/v2` promo landing or a `?code=X` URL seed on direct slug
 * entry) and never mutates after. Drives:
 *   - the landing page's `initialOfferingsFor` filter (which activity
 *     tiles to show)
 *   - the first activity's date step (greying invalid weekdays / outside
 *     window) — only while `session.items.length === 0`
 *   - the first activity's product step (slug-allowlist filter) — same
 *     condition
 *   - checkout's discount line (every cart line whose domain matches
 *     `scopes`)
 *
 * Cart cross-sell (`crossSellFor`) IGNORES this — race shows up in the
 * cross-sell tiles even if the applied code is bowling-only. Per user
 * rule: "filter only at start."
 *
 * Derived by `resolveAppliedPromo(code)` server-side. Returns null when
 * the code is unusable for any reason (anti-enumeration parity with
 * `evaluateCode`'s failure paths).
 */
export interface AppliedPromo {
  /** Raw code (uppercased — matches DB normalization). */
  code: string;
  /** Domains this code is scoped to (derived from `row.scopes`). */
  domains: DiscountDomain[];
  /** Full per-domain product allowlist (or `null` = all products in that domain). */
  scopes: DiscountScopes;
  /** Date window — ISO strings. */
  startsAt: string;
  expiresAt: string;
  /** Weekday allowlist (0–6, Sun=0); null = any weekday. */
  allowedWeekdays: number[] | null;
  /** Booking-date window (visit date), `YYYY-MM-DD`; null = any date. */
  bookingDateStart: string | null;
  bookingDateEnd: string | null;
  /** Pricing — only `percent` and `fixed` are accepted today. */
  mechanic: "percent" | "fixed";
  amountPct: number | null;
  amountCents: number | null;
  /** Square Catalog DISCOUNT id for attaching at order time. */
  squareCatalogId: string | null;
}
