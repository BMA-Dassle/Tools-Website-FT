/**
 * Square catalog reader — lookup helpers for v2 booking line items.
 *
 * Square is the source of truth for everything financial in v2 (see
 * memory: booking_v2_architecture.md). When the checkout orchestrator
 * (commit 10) needs to add a line item to the session's Square Order,
 * it looks up the matching Square catalog item via these helpers.
 *
 * Two access patterns:
 *
 *   findByBmiItemId(bmiItemId)
 *     Race v2 already knows the BMI productId from the static race-
 *     products registry. To turn that into a Square line, we look up
 *     the Square catalog item where the `BMI Item ID` custom attribute
 *     matches.
 *
 *   findByBookingActivity(activity, center?)
 *     Attractions (PR-B3) start from the activity slug. We find every
 *     Square catalog item where the `Booking Activity` custom attribute
 *     matches, optionally filtered to a center via `present_at_location_ids`.
 *
 * Both attributes are populated in Square admin per the schema in
 * `booking_v2_square_attributes.md`. When an attribute is missing, the
 * checkout orchestrator falls back to the v1 PRODUCT_ATTRACTION_MAP
 * in `apps/web/lib/attractions-data.ts` — this PR-B2 transitional path
 * lets us ship without requiring Square's catalog to be fully backfilled.
 *
 * **Real Square Catalog API wiring lands in commit 10** (alongside the
 * Square Order anchor + payment path). This file ships the interface +
 * mock + a real-impl placeholder so the service layer can compile.
 */
import { _allRaceProducts, getRaceProductById } from "../service/race-products";
import { isMockMode } from "./mock-mode";

/** Scrubbed projection of a Square catalog item the booking flow cares about. */
export interface SquareCatalogItem {
  /** Square catalog object id (used in Order line items via `catalog_object_id`). */
  catalogObjectId: string;
  /** Variation id — Square's line items reference variations, not items. */
  variationId: string;
  /** Display name (item.name; v1 sometimes overrides via name_override on the line). */
  name: string;
  /** Variation base price in cents. Source of truth for line pricing. */
  priceCents: number;
  /** Square Locations the variation is present at (`present_at_location_ids`). */
  presentAtLocationIds: string[];
  /** `BMI Item ID` custom attribute on the variation. Comma-separated supported. */
  bmiItemId: string | null;
  /** `Booking Activity` custom attribute. Values per the v2 enum
   *  (race | gel-blaster | laser-tag | duck-pin | shuffly-fasttrax |
   *  shuffly-headpinz | bowling | kbf). */
  bookingActivity: string | null;
  /** Optional `Pack Slug` attribute — only present on race-pack items
   *  (PR-B4 territory, ignored by PR-B2). */
  packSlug: string | null;
}

export interface SquareCatalogAdapter {
  /**
   * Look up a Square catalog item by its `BMI Item ID` attribute (variation
   * level). Returns the FIRST matching variation. Null when not found.
   *
   * Use case: race v2 resolves a BMI productId from the static registry,
   * then calls this to find the Square line to add to the Order.
   */
  findByBmiItemId(bmiItemId: string): Promise<SquareCatalogItem | null>;

  /**
   * Find every Square catalog item with the given `Booking Activity`
   * attribute. Filter by Square Location id when supplied (which maps
   * to a center: FT/HP Fort Myers → location X, HP Naples → location Y).
   *
   * Use case: attractions v2 (PR-B3) and confirmation pages list every
   * available item under an activity at a center.
   */
  findByBookingActivity(
    activity: string,
    options?: { locationId?: string },
  ): Promise<SquareCatalogItem[]>;

  /** Fetch a single item by catalog object id — used by the confirmation page. */
  getById(catalogObjectId: string): Promise<SquareCatalogItem | null>;
}

// ─────────────────────────── real impl (commit 10 wires) ──────────────────

const realSquareCatalogAdapter: SquareCatalogAdapter = {
  async findByBmiItemId(_bmiItemId) {
    throw new Error("squareCatalog.findByBmiItemId() real impl lands in commit 10");
  },
  async findByBookingActivity(_activity, _options) {
    throw new Error("squareCatalog.findByBookingActivity() real impl lands in commit 10");
  },
  async getById(_catalogObjectId) {
    throw new Error("squareCatalog.getById() real impl lands in commit 10");
  },
};

// ─────────────────────────── mock impl (deterministic) ────────────────────
// Mock returns a "Square-shaped" item built from the race-products
// registry + a placeholder Square id. Lets the wizard work end-to-end
// in `LOCAL_BMI_MOCK=1` + `LOCAL_SQUARE_MOCK=1` mode without any Square
// sandbox dependency.

function mockCatalogItemFor(bmiItemId: string): SquareCatalogItem | null {
  const product = getRaceProductById(bmiItemId);
  if (!product) return null;
  return {
    catalogObjectId: `mock-cat-${bmiItemId}`,
    variationId: `mock-var-${bmiItemId}`,
    name: product.name,
    priceCents: Math.round(product.price * 100),
    presentAtLocationIds: ["mock-location-fort-myers"],
    bmiItemId,
    bookingActivity: "race",
    packSlug: null,
  };
}

const mockSquareCatalogAdapter: SquareCatalogAdapter = {
  async findByBmiItemId(bmiItemId) {
    return mockCatalogItemFor(bmiItemId);
  },
  async findByBookingActivity(activity, _options) {
    if (activity !== "race") return [];
    return _allRaceProducts()
      .slice(0, 8)
      .map(
        (p): SquareCatalogItem => ({
          catalogObjectId: `mock-cat-${p.productId}`,
          variationId: `mock-var-${p.productId}`,
          name: p.name,
          priceCents: Math.round(p.price * 100),
          presentAtLocationIds: ["mock-location-fort-myers"],
          bmiItemId: p.productId,
          bookingActivity: "race",
          packSlug: null,
        }),
      );
  },
  async getById(catalogObjectId) {
    const match = catalogObjectId.match(/^mock-cat-(\d+)$/);
    if (!match) return null;
    return mockCatalogItemFor(match[1]);
  },
};

// ──────────────────────────── dispatch ────────────────────────────────────

/**
 * Adapter export — picks real vs mock at module-load. Square catalog reads
 * are FETCH-only (no mutations), so the prod-vs-dev guard mirrors square.ts:
 * production always reaches Square; dev can stub via `LOCAL_SQUARE_MOCK=1`.
 */
export const squareCatalogAdapter: SquareCatalogAdapter = isMockMode("square")
  ? mockSquareCatalogAdapter
  : realSquareCatalogAdapter;

/** Test-only exports so unit tests can exercise both impls. */
export const __testRealCatalog: SquareCatalogAdapter = realSquareCatalogAdapter;
export const __testMockCatalog: SquareCatalogAdapter = mockSquareCatalogAdapter;
