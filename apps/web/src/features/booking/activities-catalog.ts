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
import type { AppliedPromo } from "~/features/discount-codes";
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
  /** Tile display fields — used by `/book/v2` landing + future cards. Values mirror v1 `lib/attractions-data.ts` so the visual stays consistent across v1 / v2 surfaces. */
  heroImage?: string;
  accentColor?: string;
  durationLabel?: string;
}

const CATALOG: ActivityOffering[] = [
  {
    slug: "race",
    kind: "race",
    brand: "fasttrax",
    centers: ["fort-myers"],
    displayName: "High-Speed Electric Racing",
    blurb: "Florida's largest indoor go-kart racing on 3 unique tracks.",
    heroImage:
      "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/tracks/blue-track-iYCkFVDkIiDVwNQaiABoZsqzj2Fjnj.jpg",
    accentColor: "#E41C1D",
    durationLabel: "Single races & packs",
  },
  {
    slug: "duck-pin",
    kind: "attraction",
    attractionSlug: "duck-pin",
    brand: "fasttrax",
    centers: ["fort-myers"],
    displayName: "FastTrax Duckpin Bowling",
    blurb: "Modern duckpin — smaller pins, lighter balls, nonstop fun.",
    heroImage:
      "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/attractions/duckpin-bowling-R8vkBZc68YfiqmN7yP2SP2hElvWOCX.webp",
    accentColor: "#F59E0B",
    durationLabel: "30 min or 1 hour",
  },
  {
    slug: "shuffly",
    kind: "attraction",
    attractionSlug: "shuffly",
    brand: "auto",
    centers: ["fort-myers"],
    displayName: "Shuffle Showdown",
    blurb: "AR-powered shuffleboard with dynamic LED lighting and automatic scoring.",
    heroImage:
      "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/attractions/shuffly-tables-Nlc3Y5cuNU6C5WrFIhGvHN42pYMfVK.jpg",
    accentColor: "#10B981",
    durationLabel: "30 min or 1 hour",
  },
  {
    slug: "bowling",
    kind: "bowling",
    brand: "headpinz",
    centers: ["fort-myers", "naples"],
    displayName: "HeadPinz Bowling",
    blurb: "Classic & VIP bowling with NeoVerse and HyperBowling.",
    heroImage:
      "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/headpinz/gallery-bowling.webp",
    accentColor: "#fd5b56",
    durationLabel: "1-2 hours",
  },
  {
    slug: "kbf",
    kind: "kbf",
    brand: "headpinz",
    centers: ["fort-myers", "naples"],
    displayName: "Kids Bowl Free",
    blurb: "Free bowling for registered kids — Mon–Fri.",
    heroImage:
      "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/headpinz/birthday-girl-bowling.jpg",
    accentColor: "#FFD700",
    durationLabel: "Mon–Fri only",
  },
  {
    slug: "gel-blaster",
    kind: "attraction",
    attractionSlug: "gel-blaster",
    brand: "headpinz",
    centers: ["fort-myers", "naples"],
    displayName: "Nexus Gel Blaster",
    blurb: "High-tech gel blaster battles in an immersive glowing arena.",
    heroImage:
      "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/attractions/gel-blaster-new-QKNNgvKt7Jah4ZJNO7JLa3vIp2t6EK.jpg",
    accentColor: "#00E2E5",
    durationLabel: "15 min session",
  },
  {
    slug: "laser-tag",
    kind: "attraction",
    attractionSlug: "laser-tag",
    brand: "headpinz",
    centers: ["fort-myers", "naples"],
    displayName: "Nexus Laser Tag",
    blurb: "Multi-level laser tag with haptic vests and immersive lighting.",
    heroImage:
      "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/attractions/laser-tag-new-2iiYIDNemOIB9NaaGjsY0ujWAGiV5x.jpg",
    accentColor: "#8652FF",
    durationLabel: "15 min session",
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

/**
 * Does this offering fall inside a promo's scope?
 *
 *   - Returns `true` when the offering's underlying domain
 *     (race → "racing", bowling → "bowling", attraction → "attractions",
 *     kbf → "bowling" since KBF is a bowling sub-product) appears in the
 *     promo's `scopes`, AND either the per-domain allowlist is `null`
 *     (= all products) or includes the offering's slug.
 *   - KBF maps to the bowling domain because the discount-codes feature
 *     models it that way (`DiscountScopes.bowling.experienceSlugs`). KBF
 *     pass redemption is bowling-vendored in v1.
 */
export function isOfferingInPromoScope(offering: ActivityOffering, promo: AppliedPromo): boolean {
  const domain = domainForOffering(offering);
  if (!promo.domains.includes(domain)) return false;

  // The admin's slug vocabulary (per
  // `app/api/admin/discount-codes/product-catalog/route.ts`) does NOT line
  // up with v2's offering slugs for racing or bowling:
  //
  //   - Racing admin slugs are hardcoded: "adult-arrive-drive",
  //     "junior-arrive-drive", "race-pack". v2 currently has a single
  //     "race" offering.
  //   - Bowling admin slugs come from `bowling_experiences.slug`:
  //     "regular-mon-thur", "kbf-regular", "fun-4-all", etc. v2 splits this
  //     into two offerings ("bowling" + "kbf"), and `bowling_experiences.kind`
  //     ("hourly" | "open" | "kbf") decides which side a slug belongs to —
  //     but the AppliedPromo only carries slugs, not the kind.
  //   - Attractions admin slugs DO match v2 offering slugs (gel-blaster,
  //     laser-tag, duck-pin, shuffly).
  //
  // So we match looser where the vocabularies diverge:
  //   - racing scope present → highlight the race tile (no per-product
  //     split in v2 yet; race-pack is PR-B4 territory).
  //   - bowling scope null → highlight BOTH bowling + kbf tiles.
  //     bowling scope present → use the "kbf" slug-prefix heuristic
  //     (seed values are "kbf-regular" / "kbf-vip"; any added later
  //     follow the same naming) to decide which tile is in scope.
  //   - attractions scope → exact slug match.
  switch (domain) {
    case "racing":
      return true;
    case "bowling": {
      const allowed = promo.scopes.bowling?.experienceSlugs;
      if (allowed == null) return true;
      if (offering.slug === "kbf") {
        return allowed.some((s) => s.toLowerCase().startsWith("kbf"));
      }
      return allowed.some((s) => !s.toLowerCase().startsWith("kbf"));
    }
    case "attractions": {
      const allowed = promo.scopes.attractions?.slugs;
      if (allowed == null) return true;
      const matchSlug = offering.attractionSlug ?? offering.slug;
      return allowed.includes(matchSlug);
    }
  }
}

/** Map a v2 activity offering to the discount-codes domain string. */
function domainForOffering(offering: ActivityOffering): "racing" | "bowling" | "attractions" {
  if (offering.kind === "race") return "racing";
  if (offering.kind === "bowling" || offering.kind === "kbf") return "bowling";
  return "attractions";
}

/**
 * Offerings to show on the booking landing (`/book/v2`).
 *
 * Always returns the full catalog. When a promo is applied, the landing
 * does NOT filter — it shows all activities and visually highlights the
 * ones the code applies to (badge + accent border on the card). Customers
 * can still click a non-eligible tile; the promo just doesn't activate
 * for it.
 *
 * Originally (commit 8.5) this helper filtered by promo scope. Per the
 * 2026-05-21 rev 2.5 design clarification, "highlight, don't filter" is
 * the correct behavior. The helper is preserved as the LANDING's entry
 * point so future filtering (location, etc.) can plug in here without
 * surfacing more imports in the landing component.
 */
export function initialOfferingsFor(_promo: AppliedPromo | null): ActivityOffering[] {
  return allOfferings().slice();
}

/**
 * Center- and brand-aware offering order for the `/book/v2` landing.
 *
 *   - **Naples** scopes to ONLY Naples-available offerings — the FT-only
 *     race / duck-pin / shuffly drop out entirely ("HPN shows just Naples").
 *   - **Fort Myers** (or an unknown center) shows everything available there.
 *   - Within the scope, the VISITOR'S OWN brand propagates FIRST: a HeadPinz
 *     visitor sees HP activities before FastTrax; a FastTrax visitor sees FT
 *     first. `effectiveBrand` resolves shuffly's "auto" brand to the entry
 *     brand, so it groups with the visitor's side. Order within each brand
 *     group is the stable catalog order (Array.prototype.sort is stable).
 *
 * `base` is always a fresh array (offeringsAt filters; allOfferings is sliced),
 * so the in-place sort never mutates the CATALOG.
 */
export function landingOfferingsFor(
  entryBrand: Brand,
  center: CenterCode | null,
): ActivityOffering[] {
  const base = center ? offeringsAt(center) : allOfferings().slice();
  const brandRank = (o: ActivityOffering): number =>
    effectiveBrand(o, entryBrand) === entryBrand ? 0 : 1;
  return base.sort((a, b) => brandRank(a) - brandRank(b));
}
