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
