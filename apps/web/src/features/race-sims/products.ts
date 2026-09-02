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
 * ARMING CHECKLIST — ALL DONE 2026-08-26; singles are LIVE (behind the kiosk
 * tile's staff PIN gate until the guest-launch PR removes it):
 *   1. RACE_SIM_SQUARE_CATALOG_ID — DONE 2026-08-23 (owner-pasted, shared by
 *      every sim line; per-line price is overridden at charge time because
 *      one catalog id carries singles AND every pack size).
 *   2. RACE_SIM_PAGE_ID — DONE 2026-08-26 (59716066).
 *   3. RACE_SIM_TRACKS[*].bmiProductId — DONE 2026-08-26 (59535405 / 59537905
 *      / 59537953, "Race Sim - Track A/B/C").
 * To take sims off sale in an emergency, null any one of these — guard 2e
 * refuses before any Square write (and the kill switch pulls the tile).
 * BMI-side invariants (owner confirmed the setup mirrors racing's): keys carry
 * a $0/credit deposit key — a money key gets the bill's schedules stripped
 * (W57040); the dayplanner draws the SAME capacity pool the desk sees.
 *
 * Packs (3/5/10-race) carry the owner's 2026-09-01 prices and are PREPAID
 * CREDIT BUNDLES, race-pack parity (data/packs.ts): one price buys N credits
 * onto the Pandora ledger, redeemed later at $0/session. They stay
 * `bookable: false` until RACE_SIM_DEPOSIT_KIND.anytime is minted — guard 2e
 * refuses them on the missing deposit kind in its own right, because charging
 * for credits with nowhere to bank them takes money and gives nothing back.
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

// $0 track keys — owner-provided 2026-08-26 (BMI names "Race Sim - Track A/B/C").
// 8-digit product ids (safe as literals; the 17-digit precision rule is for
// bill/person ids). Transcribed from a screenshot — verify against BMI once.
export const RACE_SIM_TRACKS: readonly RaceSimTrack[] = [
  { key: "a", name: "Track A", bmiProductId: "59535405" },
  { key: "b", name: "Track B", bmiProductId: "59537905" },
  { key: "c", name: "Track C", bmiProductId: "59537953" },
] as const;

/** BMI public-booking page the three track keys live on — owner-provided
 *  2026-08-26 (racing parity: one shared page for all keys, like BUILD_PAGE_ID).
 *  With this set, every arming-checklist item is done: booking + charging are
 *  LIVE behind the kiosk tile's staff PIN gate. */
export const RACE_SIM_PAGE_ID: string | null = "59716066";

/**
 * ONE Square catalog variation for EVERY sim line (owner 2026-08-23) — the
 * human-readable variant ("1 Race · Track A") rides the line-item name, and
 * the product's price rides basePriceMoney, exactly the race-pack pattern.
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

/** Pandora deposit-kind id sim CREDITS load onto — the race-pack rail's
 *  RACE_PACK_DEPOSIT_KIND equivalent (data/packs.ts). Sim credits need their
 *  OWN kind: a race credit spends at $0 on a kart heat, and the two must never
 *  be interchangeable. NULL until the owner mints it in Pandora and hands over
 *  the id, and `raceSimItemConfigured` refuses every pack while it is null —
 *  charging for credits with nowhere to grant them takes the guest's money and
 *  gives them nothing. */
export const RACE_SIM_DEPOSIT_KIND: { anytime: string | null } = { anytime: null };

export interface RaceSimProduct {
  /** Stable cart/session key, e.g. "sim-single". */
  slug: string;
  /** single = the "1 Race" card; pack = a multi-race bundle. */
  kind: "single" | "pack";
  /** EN display name. */
  name: string;
  /** Sim races this product covers. On a PACK this is the CREDIT COUNT granted
   *  — race-pack parity (data/packs.ts `RacePack.raceCount`). */
  raceCount: number;
  /** Sticker price in USD, pre-tax. FLAT — race-pack parity: a race single is
   *  one price per tier ($20.99 adult / $15.99 junior) and the day dimension
   *  lives in the PACK VARIANTS (weekday SKU vs anytime SKU), never in a
   *  day-split on one SKU's price. Read via raceSimPriceFor(), never directly,
   *  so every surface prices from one place. */
  price: number;
  /**
   * PACKS ONLY — the Pandora deposit kind these credits load onto. A pack with
   * no kind cannot be granted, so the guard refuses it (fail-closed) on top of
   * `bookable`. Singles book a seat instead of granting credit and leave it
   * undefined.
   */
  depositKindId?: string | null;
  /**
   * PACKS ONLY — the "% off" the owner publishes for this pack. Stored as GIVEN
   * (owner 2026-09-01), not derived: the owner's own numbers are the marketing
   * truth, and they are hand-rounded rather than one formula (5-pack 18.51% was
   * taken DOWN to 18, 10-pack 24.77% UP to 25). products.test.ts pins each one
   * within a point of the real saving against the single, so the claim can
   * never quietly drift into a lie if the single price moves.
   */
  pctOff?: number;
  /** False = shown but not sellable (the product step disables the column and
   *  guard 2e refuses regardless). */
  bookable: boolean;
}

export const RACE_SIM_PRODUCTS: readonly RaceSimProduct[] = [
  {
    slug: "sim-single",
    kind: "single",
    name: "1 Race",
    raceCount: 1,
    // $15.95 flat (owner 2026-09-01). REPLACED the 2026-08-23 day-split of $14
    // Mon–Thu / $16 Fri–Sun: the pack prices below are all struck off a $15.95
    // single, and against a day-split single a flat pack price gives a
    // different discount every day — the 3-pack worked out to $14.00/race,
    // exactly the old weekday single, so "12% off" was a FALSE claim Mon–Thu.
    price: 15.95,
    bookable: true,
  },
  // ── Packs — PREPAID SIM-RACE CREDITS, race-pack parity ────────────────────
  // Owner prices 2026-09-01. Like a race pack (data/packs.ts) these are NOT a
  // booking: one price buys N credits onto the Pandora ledger, redeemed later
  // at $0/session in the normal sim flow. Still `bookable: false` — the credit
  // rail cannot exist until RACE_SIM_DEPOSIT_KIND.anytime is minted.
  {
    slug: "sim-3-pack",
    kind: "pack",
    name: "3-Race Pack",
    raceCount: 3,
    price: 41.99, // $14.00/race
    depositKindId: RACE_SIM_DEPOSIT_KIND.anytime,
    pctOff: 12,
    bookable: false,
  },
  {
    slug: "sim-5-pack",
    kind: "pack",
    name: "5-Race Pack",
    raceCount: 5,
    price: 64.99, // $13.00/race
    depositKindId: RACE_SIM_DEPOSIT_KIND.anytime,
    pctOff: 18,
    bookable: false,
  },
  {
    slug: "sim-10-pack",
    kind: "pack",
    name: "10-Race Pack",
    raceCount: 10,
    price: 119.99, // $12.00/race
    depositKindId: RACE_SIM_DEPOSIT_KIND.anytime,
    pctOff: 25,
    bookable: false,
  },
] as const;

export function getRaceSimProduct(slug: string | null): RaceSimProduct | null {
  return RACE_SIM_PRODUCTS.find((p) => p.slug === slug) ?? null;
}

/** The one accessor every surface prices through. Flat now (see
 *  `RaceSimProduct.price`); kept as a function so a future day/tier rule lands
 *  in ONE place instead of at five call sites. */
export function raceSimPriceFor(product: RaceSimProduct): number {
  return product.price;
}

/** The sim single every pack's saving is struck against. */
export function raceSimSinglePrice(): number {
  return getRaceSimProduct("sim-single")?.price ?? 0;
}

/** Per-race rate a pack works out to — DERIVED, so it can never disagree with
 *  the sticker price ($41.99 / 3 = $14.00). */
export function raceSimPackPerRace(product: RaceSimProduct): number {
  return product.raceCount > 0 ? product.price / product.raceCount : product.price;
}

/** The pack's REAL saving vs buying `raceCount` singles, as a fraction (0.1225
 *  = 12.25% off). The published badge is `pctOff`; this is what the catalog
 *  actually delivers, and the test holds the two together. */
export function raceSimPackSaving(product: RaceSimProduct): number {
  const full = raceSimSinglePrice() * product.raceCount;
  return full > 0 ? 1 - product.price / full : 0;
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
  // A PACK sells credits, so it needs somewhere to grant them. Checked in its
  // own right rather than leaning on `bookable`: whoever flips that flag on
  // launch day must not be able to arm a charge that banks nothing.
  if (product.kind === "pack" && !product.depositKindId) return false;
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
/**
 * Thrown by guard 2e when a sim's held BMI line was booked for a different
 * party size than the cart now carries (racerCount ≠ heldQty): the party
 * changed after the hold and the re-hold hasn't landed. Charging would
 * collect for N seats while BMI holds M.
 */
export class RaceSimStaleHoldError extends Error {
  readonly code = "RACESIM_STALE_HOLD" as const;
  constructor() {
    super("Your group changed after the time was held — please re-pick your time.");
    this.name = "RaceSimStaleHoldError";
  }
}

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
