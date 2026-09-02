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
import { isKbfOffered } from "@/lib/kbf-schedule";
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
  /**
   * Spanish tile copy for the KIOSK (repo rule: guest-facing copy ships EN + ES
   * in the same commit, data-borne copy included). The kiosk's attraction shelf
   * picks these when `locale === "es"` (KioskCategories → OfferingTile); the web
   * landing is English-only and ignores them.
   *
   * Omit a field to keep the English one — brand/product proper nouns
   * (FastTrax, HeadPinz, Nexus Gel Blaster, Kids Bowl Free, Shuffle Showdown)
   * stay English per the locked glossary, so most entries only translate the
   * descriptive `blurb` + `durationLabel`.
   */
  es?: {
    displayName?: string;
    blurb?: string;
    durationLabel?: string;
  };
  /** Tile display fields — used by `/book/v2` landing + future cards. Values mirror v1 `lib/attractions-data.ts` so the visual stays consistent across v1 / v2 surfaces. */
  heroImage?: string;
  accentColor?: string;
  durationLabel?: string;
  /**
   * Seasonal gate — omit for the year-round offerings (the common case).
   *
   * When present and false, the offering is dropped from every SURFACING
   * helper below: the `/book/v2` landing grid, the cart cross-sell and the
   * kiosk shelf. `findOffering()` deliberately still returns it, so the
   * route, the cart's display names and every existing reservation keep
   * resolving their slug after the season closes.
   *
   * Evaluated per call, never memoised — see the note on `isKbfOffered`.
   */
  isOffered?: (now: Date) => boolean;
}

/** The offerings on sale right now — the seasonal ones filtered out when
 *  they're between seasons. The one place `isOffered` is consulted. */
function offeredNow(list: readonly ActivityOffering[]): ActivityOffering[] {
  const now = new Date();
  return list.filter((o) => o.isOffered?.(now) ?? true);
}

const CATALOG: ActivityOffering[] = [
  {
    slug: "race",
    kind: "race",
    brand: "fasttrax",
    centers: ["fort-myers"],
    displayName: "High-Speed Electric Racing",
    blurb: "Florida's largest indoor go-kart racing on 3 unique tracks.",
    es: {
      displayName: "Carreras eléctricas de alta velocidad",
      blurb: "Las carreras de go-karts bajo techo más grandes de Florida, en 3 pistas únicas.",
      durationLabel: "Carreras sueltas y paquetes",
    },
    heroImage:
      "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/tracks/blue-track-kiosk.webp",
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
    es: {
      displayName: "Duckpin en FastTrax",
      blurb: "Duckpin moderno — pinos más pequeños, bolas más ligeras, diversión sin parar.",
      durationLabel: "30 min o 1 hora",
    },
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
    es: {
      blurb: "Shuffleboard con realidad aumentada, luces LED dinámicas y puntuación automática.",
      durationLabel: "30 min o 1 hora",
    },
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
    es: {
      displayName: "Boliche en HeadPinz",
      blurb: "Boliche Classic y VIP con NeoVerse y HyperBowling.",
      durationLabel: "1–2 horas",
    },
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
    es: {
      blurb: "Boliche gratis para niños registrados — lun a vie.",
      durationLabel: "Solo lun–vie",
    },
    heroImage:
      "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/headpinz/birthday-girl-bowling.jpg",
    accentColor: "#FFD700",
    durationLabel: "Mon–Fri only",
    // The only seasonal offering. KBF runs a fixed summer window
    // (KBF_PROGRAM_START_YMD → KBF_PROGRAM_END_YMD) and the flow behind
    // this tile has nothing to sell outside it, so the tile goes with it.
    isOffered: isKbfOffered,
  },
  {
    slug: "gel-blaster",
    kind: "attraction",
    attractionSlug: "gel-blaster",
    brand: "headpinz",
    centers: ["fort-myers", "naples"],
    displayName: "Nexus Gel Blaster",
    blurb: "High-tech gel blaster battles in an immersive glowing arena.",
    es: {
      blurb: "Batallas de gel blaster de alta tecnología en una arena luminosa e inmersiva.",
      durationLabel: "Sesión de 7 min · experiencia de 15 min",
    },
    heroImage:
      "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/attractions/gel-blaster-new-QKNNgvKt7Jah4ZJNO7JLa3vIp2t6EK.jpg",
    accentColor: "#00E2E5",
    durationLabel: "7 min session · 15 min experience",
  },
  {
    slug: "laser-tag",
    kind: "attraction",
    attractionSlug: "laser-tag",
    brand: "headpinz",
    centers: ["fort-myers", "naples"],
    displayName: "Nexus Laser Tag",
    blurb: "Multi-level laser tag with haptic vests and immersive lighting.",
    es: {
      blurb: "Laser tag de varios niveles con chalecos hápticos e iluminación inmersiva.",
      durationLabel: "Sesión de 7 min · experiencia de 15 min",
    },
    heroImage:
      "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/attractions/laser-tag-new-2iiYIDNemOIB9NaaGjsY0ujWAGiV5x.jpg",
    accentColor: "#8652FF",
    durationLabel: "7 min session · 15 min experience",
  },
];

/**
 * Look up an offering by URL slug.
 *
 * NOT season-filtered, on purpose. A closed season hides the TILE; it must
 * never stop a slug resolving, or the route that renders the "we're back
 * next summer" notice, the cart's display names and every reservation
 * already taken for that activity would all lose their labels.
 */
export function findOffering(slug: string): ActivityOffering | undefined {
  return CATALOG.find((o) => o.slug === slug);
}

/** All offerings on sale right now, in display order. */
export function allOfferings(): readonly ActivityOffering[] {
  return offeredNow(CATALOG);
}

/** Offerings on sale right now at a given center. */
export function offeringsAt(center: CenterCode): ActivityOffering[] {
  return offeredNow(CATALOG).filter((o) => o.centers.includes(center));
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
    // Combo special: only ATTRACTIONS may join the cart. Adding another
    // race/bowling/KBF would break the strict pricing gate and silently fall
    // the whole cart back to item-sum (regular) rates — a charge surprise.
    if (session.comboSpecialId && o.kind !== "attraction") return false;
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
  //   - bowling scope null → highlight the regular bowling tile only. KBF
  //     (Kids Bowl Free) is OPT-IN: a generic/all-bowling code does NOT cover
  //     it — only a code that explicitly lists kbf-* slugs badges the KBF tile
  //     (seed values are "kbf-regular" / "kbf-vip"; any added later follow the
  //     same naming).
  //   - attractions scope → exact slug match.
  switch (domain) {
    case "racing":
      return true;
    case "bowling": {
      const allowed = promo.scopes.bowling?.experienceSlugs;
      if (offering.slug === "kbf") {
        // Opt-in: never badge KBF off a null/all-bowling scope.
        return allowed != null && allowed.some((s) => s.toLowerCase().startsWith("kbf"));
      }
      if (allowed == null) return true;
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
/** HeadPinz landing surfaces these first, in this order (bowling → KBF → gel
 *  blaster); everything else follows in catalog order. */
const HP_LANDING_PRIORITY: Record<string, number> = { bowling: 0, kbf: 1, "gel-blaster": 2 };

export function landingOfferingsFor(
  entryBrand: Brand,
  center: CenterCode | null,
): ActivityOffering[] {
  const base = center ? offeringsAt(center) : allOfferings().slice();
  const brandRank = (o: ActivityOffering): number =>
    effectiveBrand(o, entryBrand) === entryBrand ? 0 : 1;
  // HeadPinz lead order; non-HeadPinz brands keep catalog order (rank 0 for all).
  const hpRank = (o: ActivityOffering): number =>
    entryBrand === "headpinz" ? (HP_LANDING_PRIORITY[o.slug] ?? 99) : 0;
  // Stable sort: own-brand first, then the HeadPinz lead order, then catalog order.
  return base.sort((a, b) => brandRank(a) - brandRank(b) || hpRank(a) - hpRank(b));
}
