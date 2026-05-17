/**
 * Single source of truth for what v2 booking offers.
 *
 * Every activity the wizard can book lives here as a typed
 * ActivityOffering. The catalog drives:
 *   - cross-sell tiles (AdditionalActivities in the cart)
 *   - per-center availability filtering
 *   - shuffly's FT-side vs HP-side resolution from session.entryBrand
 *   - mapping URL slug → SessionItem kind / attraction slug
 *   - resolving an offering's Square `Booking Activity` attribute value
 *
 * Race-packs are NOT here — they are credit-pack purchases, not bookings.
 * (They come back in PR-B4 as a separate catalog of credit-pack offerings.)
 *
 * A runtime config layer (Neon table + admin UI) is captured in
 * tasks/future/activity-config-layer.md and intentionally deferred.
 * This file is the source of truth until that PR ships, at which point
 * Neon overrides will overlay onto the same shape.
 *
 * Locked center / brand matrix (see memory: booking_v2_architecture.md):
 *   Activity    | Brand   | Fort Myers | Naples
 *   race        | FT      | ✅         | ❌
 *   duck-pin    | FT      | ✅         | ❌
 *   shuffly     | auto¹   | ✅         | ❌
 *   bowling     | HP      | ✅         | ✅
 *   kbf         | HP      | ✅         | ✅
 *   gel-blaster | HP      | ✅         | ✅
 *   laser-tag   | HP      | ✅         | ✅
 *
 * ¹ shuffly resolves to FT-side or HP-side based on session.entryBrand —
 *   different physical buildings at the Fort Myers complex with separate
 *   BMI product sets.
 */
import type { Activity, Brand, CenterCode } from "./types";
import type { BookingSession } from "./state/types";

/** Brand-styling hint for an offering. "auto" = use session.entryBrand. */
export type OfferingBrand = Brand | "auto";

export interface ActivityOffering {
  /** URL slug (also used by routing in /book/<slug>/v2). */
  slug: string;
  /** Which SessionItem kind this offering produces. */
  kind: Activity;
  /**
   * For "attraction" kinds, the attraction-specific slug carried on the
   * AttractionItem ("gel-blaster", "laser-tag", etc.). Same as `slug`
   * for attractions; omitted for non-attractions.
   */
  attractionSlug?: string;
  brand: OfferingBrand;
  /** Physical complexes where this offering is available. */
  centers: CenterCode[];
  /** Cross-sell tile copy. */
  displayName: string;
  blurb: string;
}

const CATALOG: ActivityOffering[] = [
  {
    slug: "race",
    kind: "race",
    brand: "fasttrax",
    centers: ["fort-myers"],
    displayName: "Go-kart racing",
    blurb: "Indoor electric karts on three FastTrax tracks.",
  },
  {
    slug: "duck-pin",
    kind: "attraction",
    attractionSlug: "duck-pin",
    brand: "fasttrax",
    centers: ["fort-myers"],
    displayName: "Duckpin bowling",
    blurb: "Modern duckpin — smaller pins, lighter balls, fast turns.",
  },
  {
    slug: "shuffly",
    kind: "attraction",
    attractionSlug: "shuffly",
    brand: "auto",
    centers: ["fort-myers"],
    displayName: "Shuffly",
    blurb: "AR-powered shuffleboard with dynamic LED lighting.",
  },
  {
    slug: "bowling",
    kind: "bowling",
    brand: "headpinz",
    centers: ["fort-myers", "naples"],
    displayName: "Bowling",
    blurb: "Classic & VIP bowling with NeoVerse and HyperBowling.",
  },
  {
    slug: "kbf",
    kind: "kbf",
    brand: "headpinz",
    centers: ["fort-myers", "naples"],
    displayName: "Kids Bowl Free",
    blurb: "Free summer bowling for registered kids — Mon–Fri.",
  },
  {
    slug: "gel-blaster",
    kind: "attraction",
    attractionSlug: "gel-blaster",
    brand: "headpinz",
    centers: ["fort-myers", "naples"],
    displayName: "Gel blasters",
    blurb: "High-tech gel blaster battles in an immersive glowing arena.",
  },
  {
    slug: "laser-tag",
    kind: "attraction",
    attractionSlug: "laser-tag",
    brand: "headpinz",
    centers: ["fort-myers", "naples"],
    displayName: "Laser tag",
    blurb: "Multi-level laser tag with haptic vests and immersive lighting.",
  },
];

/** Look up an offering by URL slug. */
export function findOffering(slug: string): ActivityOffering | undefined {
  return CATALOG.find((o) => o.slug === slug);
}

/** All offerings, in display order. */
export function allOfferings(): readonly ActivityOffering[] {
  return CATALOG;
}

/** Offerings available at a given center. */
export function offeringsAt(center: CenterCode): ActivityOffering[] {
  return CATALOG.filter((o) => o.centers.includes(center));
}

/** Centers shared by every center in `set` — used for cart constraint checks. */
export function intersectCenters(sets: CenterCode[][]): CenterCode[] {
  if (sets.length === 0) return [];
  const [first, ...rest] = sets;
  return first.filter((c) => rest.every((r) => r.includes(c)));
}

/**
 * Cross-sell offerings for a session — what to suggest in the cart.
 *
 * Rules:
 *   - Filter by `session.center` if locked; otherwise show everything
 *     available at any center the customer might pick.
 *   - Exclude offerings whose kind already exists in the cart (one of
 *     each kind per cart, e.g. don't suggest "race" if there's already
 *     a race item). Tunable later if we want to allow multiple of the
 *     same kind (e.g. two separate race heats).
 *   - For "attraction" kind, exclude only the specific attraction slug
 *     already present, not all attractions. A cart with a gel-blaster
 *     can still cross-sell laser-tag.
 */
export function crossSellFor(session: BookingSession): ActivityOffering[] {
  const inCart = new Set(
    session.items.map((i) => (i.kind === "attraction" ? `attraction:${i.slug}` : i.kind)),
  );
  const base = session.center ? offeringsAt(session.center) : allOfferings().slice();
  return base.filter((o) => {
    const key = o.kind === "attraction" ? `attraction:${o.attractionSlug}` : o.kind;
    return !inCart.has(key);
  });
}

/**
 * Square's `Booking Activity` custom attribute value for an offering, given
 * the session's entryBrand. Used by the BMI adapter (commit 6) to find the
 * right Square catalog item.
 *
 * Shuffly is the only offering where this resolves dynamically — FT entry
 * picks shuffly-fasttrax, HP entry picks shuffly-headpinz.
 *
 * (See memory: booking_v2_square_attributes.md.)
 */
export function squareBookingActivity(offering: ActivityOffering, entryBrand: Brand): string {
  if (offering.slug === "shuffly") return `shuffly-${entryBrand}`;
  return offering.slug;
}

/** Resolve the effective brand for theming an offering's tile / chrome. */
export function effectiveBrand(offering: ActivityOffering, entryBrand: Brand): Brand {
  return offering.brand === "auto" ? entryBrand : offering.brand;
}
