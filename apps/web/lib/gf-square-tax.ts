/**
 * Where a group-function day-of order's TAX and SERVICE CHARGE belong on a Square order.
 *
 * WHAT THIS REPLACES (the 2026-08-17 investigation, orders GF-3471 / GF-3404 / GF-H3176):
 *   The day-of order used to put both amounts in the wrong slot, and they looked alike
 *   in the dashboard, which is why it went unnoticed for ~380 events:
 *     - TAX went into `service_charges: [{ name: "Service Charge" }]`. It was the right
 *       number of dollars — `quote.tax_cents` verbatim — so guests paid correctly, but
 *       Square's `total_tax_money` read $0.00 on every group event and the tax never
 *       appeared in a tax report. $22,616.55 across 211 live day-of orders.
 *     - The real SERVICE CHARGE arrived as a catalog LINE ITEM whose id
 *       (IBXWNWIZRCEY4B4RXK4JXD5G) belongs to a Square item named "Legacy Service
 *       Charge" — i.e. it booked as merchandise, not as a service charge. $105,732.58.
 *
 * The correct Square objects already existed in the catalog; nothing was wired to them.
 * This module maps a contract's products onto them:
 *     merchandise  → line items, each carrying only the taxes ITS OWN BMI rate implies
 *     service chg  → a real `service_charges[]` entry on a catalog SERVICE_CHARGE object
 *     tax          → catalog TAX objects at LINE_ITEM scope, so Square computes it
 *
 * WHY LINE_ITEM SCOPE AND NOT ORDER SCOPE. An order-scope tax is simpler and reproduces
 * the total exactly for the ~97% single-rate case, but it applies to every line with no
 * way to exempt one. 13 of 436 events need per-line rates: Naples events mix 6.0% with
 * 6.59% (Collier 6.0% + Alcohol 0.59%, which BMI puts on soda pitchers too), and some
 * Fort Myers events carry genuinely untaxed lines alongside taxed ones. LINE_ITEM scope
 * covers both; verified against /orders/calculate on real events at all three venues.
 *
 * WHY WE NEVER GUESS. A rate we cannot express as "county" or "county + alcohol" returns
 * null, and an unmapped location returns null — the caller then falls back to the legacy
 * shape rather than book a tax we invented. Mis-taxing a guest is far worse than
 * continuing to mis-CLASSIFY a correct total for one more event.
 */

import { buildSquareLineItem } from "@/lib/plu-catalog-map";
import { isServiceChargeProduct } from "@/lib/service-charge";

/**
 * Catalog TAX objects, keyed by the Square LOCATION the order is created at — not by
 * center_code. FastTrax and HeadPinz Fort Myers share one BMI client, so an event can
 * move venue and have its `square_location_id` re-synced under it (see
 * reconcileDayofOrder); the location is what decides the jurisdiction.
 *
 * Every entry is the tax Square itself reports as present at that location — read from
 * `present_at_location_ids`, not inferred from the venue's address.
 */
const COUNTY_TAX_BY_LOCATION: Record<string, { id: string; rate: number }> = {
  TXBSQN0FEKQ11: { id: "UBPQTR3W6ZKVRYFC7DXN2SJN", rate: 0.065 }, // HeadPinz Fort Myers — Lee
  LAB52GY480CJF: { id: "UBPQTR3W6ZKVRYFC7DXN2SJN", rate: 0.065 }, // FastTrax Fort Myers — Lee
  "6MZJFTGAYD7TC": { id: "UBPQTR3W6ZKVRYFC7DXN2SJN", rate: 0.065 }, // HeadPinz & FastTrax Ent. — Lee
  LBT9R6Z4S0CYY: { id: "UBPQTR3W6ZKVRYFC7DXN2SJN", rate: 0.065 }, // BowlMarc — Lee
  PPTR5G2N0QXF7: { id: "BQNVIEEZQO2PX2FI72U6FEC4", rate: 0.06 }, // HeadPinz Naples — Collier
  AP9CY28EAR7HJ: { id: "QSM64BRFPOKJ6HMSGIQNLNXM", rate: 0.07 }, // Bowland Port Charlotte — Charlotte
};

/** Present at all locations. BMI stacks it on alcohol AND on soda pitchers. */
const ALCOHOL_TAX_ID = "FDQQD6P6SX6LID2SMZWZBZZA";
const ALCOHOL_TAX_RATE = 0.0059;

/**
 * Catalog SERVICE_CHARGE objects, by tier percentage. Preferred over the amount-based
 * custom charge because the tier shows up by name in Square's reporting. T/E variants
 * exist so a tax-exempt event stays distinguishable in those same reports.
 */
const TIER_SERVICE_CHARGE: Record<number, string> = {
  15: "JBTVYHRA6ZKRHS6QXUN2DWG5",
  14: "FV7GH3OKNSMDKORSTY3HZJH4",
  13: "4NYXQNNF7XKQ765GLRLTZJAX",
  12: "L6CH4VYWCBBXKE4G2C5OZU2Y",
};
const TIER_SERVICE_CHARGE_TAX_EXEMPT: Record<number, string> = {
  15: "TN6YZ5CLF5DNOIGVXKC2NNIN",
  14: "3LFCGZFNXWVREQUHEJLGS4NH",
  13: "45MD767EWXSJ2UEXRH2ERGSN",
  12: "SGWFFIEJBAUYCJ262UNOEPAI",
};
/** Amount-based fallback, for a service charge that is off-tier (hand-corrected in BMI). */
const CUSTOM_SERVICE_CHARGE_ID = "TIBEGW6ZKDMTC7CGNBSZEAAB";

const COUNTY_UID = "gf-county-tax";
const ALCOHOL_UID = "gf-alcohol-tax";
const SERVICE_CHARGE_UID = "gf-service-charge";

/** BMI sends rates as floats (0.0659). Tolerance well below the 0.59% alcohol delta. */
const RATE_EPSILON = 0.0005;
/** A tier is "the" tier only if it lands on the contract amount to the cent. */
const TIER_MATCH_TOLERANCE_CENTS = 1;

export interface GfTaxProduct {
  name: string;
  price: number;
  qty: number;
  total: number;
  /** Per-line tax RATE (0.065), not dollars — see group-function-pricing.ts. */
  tax: number;
  plu: string;
}

type TaxRef = { tax_uid: string };

export interface DayofOrderShape {
  line_items: Array<Record<string, unknown>>;
  service_charges?: Array<Record<string, unknown>>;
  taxes?: Array<Record<string, unknown>>;
}

const near = (a: number, b: number) => Math.abs(a - b) <= RATE_EPSILON;

/**
 * Which catalog taxes a line at `rate` needs, given its county rate.
 * `null` means "cannot express this rate" — the caller must bail, not approximate.
 */
function taxesForRate(rate: number, countyRate: number): TaxRef[] | null {
  if (rate <= RATE_EPSILON) return [];
  if (near(rate, countyRate)) return [{ tax_uid: COUNTY_UID }];
  if (near(rate, countyRate + ALCOHOL_TAX_RATE))
    return [{ tax_uid: COUNTY_UID }, { tax_uid: ALCOHOL_UID }];
  return null;
}

/** The tiered catalog service charge whose percentage lands on `scCents`, if any. */
function tierServiceChargeId(
  scCents: number,
  merchCents: number,
  taxExempt: boolean,
): string | undefined {
  if (merchCents <= 0) return undefined;
  const table = taxExempt ? TIER_SERVICE_CHARGE_TAX_EXEMPT : TIER_SERVICE_CHARGE;
  for (const pct of [15, 14, 13, 12]) {
    const atTier = Math.round((merchCents * pct) / 100);
    if (Math.abs(atTier - scCents) <= TIER_MATCH_TOLERANCE_CENTS) return table[pct];
  }
  return undefined;
}

/**
 * Build the tax/service-charge-correct body for a day-of order, or `null` when this
 * contract cannot be modelled faithfully (unmapped location, a per-line rate that is
 * neither the county rate nor county+alcohol, or nothing but a service charge).
 *
 * `null` is a normal outcome, not an error — the caller keeps the legacy shape.
 */
export function buildDayofOrderShape(args: {
  centerCode: string;
  locationId: string;
  products: GfTaxProduct[];
  taxExempt: boolean;
}): DayofOrderShape | null {
  const { centerCode, locationId, products, taxExempt } = args;

  const county = COUNTY_TAX_BY_LOCATION[locationId];
  if (!county) return null;

  /**
   * A contract can carry MORE THAN ONE service-charge line — H3222 has two identical
   * "GF Service Charge - 15%" lines, one per section. They collapse into a single Square
   * service charge; taking only the first (an early `.find` here) left the rest booked as
   * "Legacy Service Charge" merchandise with the total still coming out right, which is
   * exactly the failure this whole module exists to end.
   */
  const scProducts = products.filter((p) => isServiceChargeProduct(p.name, p.plu));
  const merch = products.filter((p) => !scProducts.includes(p));
  if (merch.length === 0) return null;

  let usesCounty = false;
  let usesAlcohol = false;
  const noteUsage = (refs: TaxRef[]) => {
    for (const r of refs) {
      if (r.tax_uid === COUNTY_UID) usesCounty = true;
      if (r.tax_uid === ALCOHOL_UID) usesAlcohol = true;
    }
  };

  const line_items: Array<Record<string, unknown>> = [];
  for (const p of merch) {
    const refs = taxesForRate(taxExempt ? 0 : p.tax || 0, county.rate);
    if (refs === null) return null;
    noteUsage(refs);
    line_items.push({
      ...buildSquareLineItem(centerCode, p),
      ...(refs.length > 0 ? { applied_taxes: refs } : {}),
    });
  }

  let service_charges: Array<Record<string, unknown>> | undefined;
  const scCents = scProducts.reduce((s, p) => s + Math.round((p.total || 0) * 100), 0);
  if (scProducts.length > 0 && scCents > 0) {
    // Every service-charge line must imply the SAME taxes, or they cannot be collapsed
    // into one Square service charge without misstating tax on part of it.
    const perLine = scProducts.map((p) => taxesForRate(taxExempt ? 0 : p.tax || 0, county.rate));
    if (perLine.some((r) => r === null)) return null;
    const keys = new Set(perLine.map((r) => r!.map((x) => x.tax_uid).join("+")));
    if (keys.size > 1) return null;
    const scRefs = perLine[0]!;
    noteUsage(scRefs);

    const merchCents = Math.round(merch.reduce((s, p) => s + (p.total || 0), 0) * 100);
    const tierId = tierServiceChargeId(scCents, merchCents, taxExempt);
    service_charges = [
      {
        uid: SERVICE_CHARGE_UID,
        catalog_object_id: tierId ?? CUSTOM_SERVICE_CHARGE_ID,
        // A tiered object carries its own percentage; Square computes the amount. The
        // custom object has none, so it needs the contract amount spelled out.
        ...(tierId ? {} : { amount_money: { amount: scCents, currency: "USD" } }),
        ...(scRefs.length > 0 ? { applied_taxes: scRefs } : {}),
      },
    ];
  }

  const taxes: Array<Record<string, unknown>> = [];
  if (usesCounty) taxes.push({ uid: COUNTY_UID, catalog_object_id: county.id, scope: "LINE_ITEM" });
  if (usesAlcohol)
    taxes.push({ uid: ALCOHOL_UID, catalog_object_id: ALCOHOL_TAX_ID, scope: "LINE_ITEM" });

  return {
    line_items,
    ...(service_charges ? { service_charges } : {}),
    ...(taxes.length > 0 ? { taxes } : {}),
  };
}

/** Exposed for the smoke script + tests, so neither re-hardcodes the ids. */
export const GF_TAX_INTERNALS = {
  COUNTY_TAX_BY_LOCATION,
  ALCOHOL_TAX_ID,
  ALCOHOL_TAX_RATE,
  TIER_SERVICE_CHARGE,
  TIER_SERVICE_CHARGE_TAX_EXEMPT,
  CUSTOM_SERVICE_CHARGE_ID,
} as const;
