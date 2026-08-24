/**
 * Race Sims catalog — the SINGLE SEAM between the kiosk flow and real money.
 *
 * Racing simulators at FastTrax Fort Myers. Books like gel/laser (one BMI
 * resource "Race Sim", capacity 4/slot, guest picks a time), keyed like
 * racing ($0 BMI key products — BMI holds the seat at $0, Square owns the
 * money). Owner setup 2026-08-23: ONE $0 key per track; all three keys show
 * the SAME sessions (shared resource/dayplanner, minitrack-shaped schedule),
 * so the track choice picks WHICH key books, never which times exist.
 *
 * ARMING CHECKLIST (checkout is fail-closed until ALL of these are set):
 *   1. RACE_SIM_SQUARE_CATALOG_ID — DONE 2026-08-23 (owner-pasted, shared by
 *      every sim line; per-line price is overridden at charge time because
 *      pricing is day-of-week based).
 *   2. RACE_SIM_PAGE_ID — the BMI public-booking page the track keys live on.
 *   3. RACE_SIM_TRACKS[*].bmiProductId — the three $0 track keys (RAW digit
 *      strings, copied verbatim from BMI — NEVER through Number()/JSON.parse,
 *      @ft/db BMI id precision rule).
 * BMI-side invariants (owner confirmed the setup mirrors racing's): keys carry
 * a $0/credit deposit key — a money key gets the bill's schedules stripped
 * (W57040); the dayplanner draws the SAME capacity pool the desk sees.
 *
 * Packs (3/5-race) are DEFERRED (owner 2026-08-23: "ignore the package keys
 * for now") — `bookable: false` hides their tap targets and guard 2e refuses
 * them even if a stale session carries one. Singles first.
 *
 * Catalog lives HERE in code, never in Square — same rule as race-products.ts
 * and data/packs.ts.
 */

export type RaceSimTrackKey = "a" | "b" | "c";

export interface RaceSimTrack {
  key: RaceSimTrackKey;
  /** EN display label — PLACEHOLDER until the rotating lineup is named. */
  name: string;
  /**
   * The track's $0 BMI key product — RAW digit string, null until the owner
   * hands it over. All three keys book the same "Race Sim" resource sessions;
   * BMI's freeSpots (capacity 4) is shared across them.
   */
  bmiProductId: string | null;
}

export const RACE_SIM_TRACKS: readonly RaceSimTrack[] = [
  { key: "a", name: "Track A", bmiProductId: null },
  { key: "b", name: "Track B", bmiProductId: null },
  { key: "c", name: "Track C", bmiProductId: null },
] as const;

/** BMI public-booking page the track keys live on — null until owner-provided
 *  (racing parity: one shared page for all keys, like BUILD_PAGE_ID). */
export const RACE_SIM_PAGE_ID: string | null = null;

/**
 * ONE Square catalog variation for EVERY sim line (owner 2026-08-23) — the
 * human-readable variant ("1 Race · Track A") rides the line-item name, and
 * the day-of-week price rides basePriceMoney, exactly the race-pack pattern.
 */
export const RACE_SIM_SQUARE_CATALOG_ID: string | null = "PZXWYNOY4MUAPXACMBMTFYMD";

export function getRaceSimTrack(key: string | null): RaceSimTrack | null {
  return RACE_SIM_TRACKS.find((t) => t.key === key) ?? null;
}

/** The (productId, pageId) a sim booking hits BMI with — bmiBookingTarget
 *  parity. Null until the track's key AND the shared page are armed; the
 *  slot step shows nothing and guard 2e refuses while this is null. */
export function raceSimBookingTarget(
  trackKey: string | null,
): { productId: string; pageId: string } | null {
  const track = getRaceSimTrack(trackKey);
  if (!track?.bmiProductId || !RACE_SIM_PAGE_ID) return null;
  return { productId: track.bmiProductId, pageId: RACE_SIM_PAGE_ID };
}

export interface RaceSimProduct {
  /** Stable cart/session key, e.g. "sim-single". */
  slug: string;
  /** single = the "1 Race" card; pack = a multi-race bundle. */
  kind: "single" | "pack";
  /** EN display name. */
  name: string;
  /** Sim races granted per racer. */
  raceCount: number;
  /** Per-racer sticker prices, USD pre-tax (owner 2026-08-23): weekday =
   *  Mon–Thu, weekend = Fri–Sun (house day-split — packs/combos convention).
   *  Read via raceSimPriceFor(), never directly, so every surface prices the
   *  same day the same way. */
  priceWeekday: number;
  priceWeekend: number;
  /** False = shown but not sellable (pack keys not minted yet — the product
   *  step disables the column and guard 2e refuses regardless). */
  bookable: boolean;
}

export const RACE_SIM_PRODUCTS: readonly RaceSimProduct[] = [
  {
    slug: "sim-single",
    kind: "single",
    name: "1 Race",
    raceCount: 1,
    priceWeekday: 14,
    priceWeekend: 16,
    bookable: true,
  },
  // Packs deferred (owner 2026-08-23) — placeholder prices, no keys, not
  // bookable. Flip `bookable` + arm their keys when the owner mints them.
  {
    slug: "sim-3-pack",
    kind: "pack",
    name: "3-Race Pack",
    raceCount: 3,
    priceWeekday: 39.99,
    priceWeekend: 39.99,
    bookable: false,
  },
  {
    slug: "sim-5-pack",
    kind: "pack",
    name: "5-Race Pack",
    raceCount: 5,
    priceWeekday: 59.99,
    priceWeekend: 59.99,
    bookable: false,
  },
] as const;

export function getRaceSimProduct(slug: string | null): RaceSimProduct | null {
  return RACE_SIM_PRODUCTS.find((p) => p.slug === slug) ?? null;
}

/** Fri/Sat/Sun = weekend (house convention: race packs' "weekday" is Mon–Thu).
 *  null/garbage dates price as WEEKEND — the higher rate — so a missing date
 *  can never undercharge. */
export function raceSimPriceFor(product: RaceSimProduct, ymd: string | null): number {
  if (!ymd) return product.priceWeekend;
  const d = new Date(`${ymd}T12:00:00`);
  if (Number.isNaN(d.getTime())) return product.priceWeekend;
  const dow = d.getDay(); // 0=Sun … 6=Sat
  return dow === 0 || dow === 5 || dow === 6 ? product.priceWeekend : product.priceWeekday;
}

/**
 * The seam reserve guard 2e reads: a sim ITEM may charge only when its
 * product is bookable, the shared Square id is set, AND its track's BMI key +
 * page are armed (a Square id alone would charge with no reservation).
 */
export function raceSimItemConfigured(item: {
  productSlug: string | null;
  trackKey: string | null;
}): boolean {
  const product = getRaceSimProduct(item.productSlug);
  if (!product || !product.bookable) return false;
  if (!RACE_SIM_SQUARE_CATALOG_ID) return false;
  return raceSimBookingTarget(item.trackKey) != null;
}

/** Thrown by unified-reserve guard 2e for any racesim item that isn't fully
 *  configured. Caught by the reserve routes → 409 with `code`, so the kiosk
 *  shows a staff-readable message instead of arming a charge. */
export class RaceSimNotConfiguredError extends Error {
  readonly code = "RACESIM_NOT_CONFIGURED" as const;
  constructor(slug: string | null) {
    super(
      "Race sim checkout isn't live yet — please see the front desk." +
        (slug ? ` (product: ${slug})` : ""),
    );
    this.name = "RaceSimNotConfiguredError";
  }
}

/**
 * Thrown by guard 2e when a cart mixes Race Sims with HeadPinz-entity items
 * (bowling/KBF/gel/laser/shuffly): the day-of order books at ONE Square
 * location, so the sim revenue would land in the HeadPinz account. Until the
 * combo-split-orders treatment covers sims, the cart must be paid separately.
 */
export class RaceSimMixedCartError extends Error {
  readonly code = "RACESIM_MIXED_CART" as const;
  constructor() {
    super(
      "Race Sims must be paid separately from bowling and attractions for now — " +
        "please check out the sims on their own.",
    );
    this.name = "RaceSimMixedCartError";
  }
}
