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
  /**
   * STABLE, MACHINE-FACING label. NEVER show this to a guest, and NEVER change
   * it — not even to something prettier.
   *
   * It is written into `booking_metadata.racesims[].track` at reserve and read
   * back out of Neon (lib/bowling-db.ts raceHeatsForPersonsOnDate) to decide
   * whether an existing booking is a sim, which selects the same-start rule
   * over the 30-minute cross-activity rule (scheduling.ts isRaceSimTrackLabel).
   * Change it and every sim ALREADY SOLD stops being recognised as a sim.
   *
   * What the guest reads is the CIRCUIT running on this key — circuits.ts
   * `circuitForTrack(key, date)` — which rotates. The two must stay separate
   * for exactly that reason: the circuit changes every lineup, this cannot.
   */
  conflictLabel: string;
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
  { key: "a", conflictLabel: "Track A", bmiProductId: "59535405" },
  { key: "b", conflictLabel: "Track B", bmiProductId: "59537905" },
  { key: "c", conflictLabel: "Track C", bmiProductId: "59537953" },
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

/**
 * BMI product id → our track key. The id is AUTHORITATIVE: it is what we sent
 * BMI when the seat was held, so it round-trips exactly.
 *
 * This is the front half of "a scanned QR says Track A, show me the circuit" —
 * pair it with circuits.ts `circuitForTrack(key, date)`.
 */
export function raceSimTrackKeyForProductId(
  productId: string | null | undefined,
): RaceSimTrackKey | null {
  if (!productId) return null;
  const raw = String(productId).trim();
  return RACE_SIM_TRACKS.find((t) => t.bmiProductId === raw)?.key ?? null;
}

/** Is this BMI product one of our sim track keys at all? */
export function isRaceSimProductId(productId: string | null | undefined): boolean {
  return raceSimTrackKeyForProductId(productId) != null;
}

/**
 * BMI product NAME → our track key, for the paths that only carry a label
 * (a bill line's description, a scanned session's product name).
 *
 * Deliberately permissive about the separator and spacing, because the name is
 * typed by hand in BMI and "Race Sim - Track A" / "Race Sim – Track A" /
 * "Race Sim Track A" are all the same thing to a human. Anchored on the
 * trailing key letter so it cannot match some other product that merely
 * mentions a sim. Prefer `raceSimTrackKeyForProductId` whenever an id is
 * available — a name can be renamed in BMI, an id cannot.
 */
export function raceSimTrackKeyFromBmiName(
  name: string | null | undefined,
): RaceSimTrackKey | null {
  if (!name) return null;
  const m = /race\s*sim\b.*?\btrack\s*([abc])\b/i.exec(name);
  const letter = m?.[1]?.toLowerCase();
  return letter === "a" || letter === "b" || letter === "c" ? letter : null;
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
  /**
   * SINGLES ONLY. False = shown but not sellable (the product step disables
   * the column and guard 2e refuses regardless).
   *
   * Packs deliberately do NOT carry this: their sellability is DERIVED from
   * `depositKindId` by `raceSimProductBookable()`. A hand-set flag and a
   * deposit kind are two switches for one fact, and the failure mode of them
   * disagreeing is the worst one this catalog has — a pack that takes money
   * and banks no credits. Deriving it means the owner minting the Pandora kind
   * and pasting the id is the ENTIRE launch step, and there is no flag anyone
   * can flip early.
   */
  bookable?: boolean;
}

/**
 * May this product be sold right now?
 *
 * Singles: the explicit flag (default true). Packs: only once their Pandora
 * deposit kind is armed — see the note on `bookable`. Every surface and the
 * reserve guard read THIS, never `product.bookable` directly.
 */
export function raceSimProductBookable(product: RaceSimProduct): boolean {
  if (product.kind === "pack") return !!product.depositKindId;
  return product.bookable !== false;
}

export const RACE_SIM_PRODUCTS: readonly RaceSimProduct[] = [
  {
    slug: "sim-single",
    kind: "single",
    name: "1 Race",
    raceCount: 1,
    // $14.95 flat (owner 2026-09-15) — the number Jacob published in Teams on
    // 2026-08-25 ("at $14.95 per race"), which the catalog had never matched.
    //
    // The catalog carried $15.95 because the pack ladder was reverse-engineered
    // from it: $41.99/$64.99/$119.99 are 12.25% / 18.51% / 24.77% off $15.95,
    // and only off $15.95. Against the $14.95 that was actually advertised they
    // were 6.4% / 13.1% / 19.7% — the 3-pack claiming almost double its real
    // saving. The owner's call was to keep the ADVERTISED single and re-cut the
    // packs so the published percentages are true, so the pack prices below
    // moved instead of this one.
    //
    // (History: this replaced a 2026-08-23 day-split of $14 Mon–Thu / $16
    // Fri–Sun. A flat pack price against a day-split single gives a different
    // discount every day, which is why the split had to die — race-pack parity
    // puts the day dimension in the pack VARIANTS, never in one SKU's price.)
    price: 14.95,
    bookable: true,
  },
  // ── Packs — PREPAID SIM-RACE CREDITS, race-pack parity ────────────────────
  // Owner prices 2026-09-01. Like a race pack (data/packs.ts) these are NOT a
  // booking: one price buys N credits onto the Pandora ledger, redeemed later
  // at $0/session in the normal sim flow. Still `bookable: false` — the credit
  // rail cannot exist until RACE_SIM_DEPOSIT_KIND.anytime is minted.
  // The ladder was RE-CUT 2026-09-15 when the single moved to its advertised
  // $14.95 (owner: keep 12 / 18 / 25 and move the pack prices). Each price is
  // the tidiest number that makes its published claim TRUE against $14.95 —
  // products.test.ts holds every claim within a point of the real saving, so a
  // price typo fails the build instead of shipping a false discount.
  //
  // Note for whoever next edits these: a .99 ending cannot carry 12% off the
  // 3-pack. 12% of 3 × $14.95 caps the price at $39.92, and the nearest .99
  // ($39.99) is only 10.8% off — it would have to publish 11%. $39.45 holds
  // the owner's 12%.
  {
    slug: "sim-3-pack",
    kind: "pack",
    name: "3-Race Pack",
    raceCount: 3,
    price: 39.45, // $13.15/race — 12.04% off
    depositKindId: RACE_SIM_DEPOSIT_KIND.anytime,
    pctOff: 12,
  },
  {
    slug: "sim-5-pack",
    kind: "pack",
    name: "5-Race Pack",
    raceCount: 5,
    price: 60.95, // $12.19/race — 18.46% off
    depositKindId: RACE_SIM_DEPOSIT_KIND.anytime,
    pctOff: 18,
  },
  {
    slug: "sim-10-pack",
    kind: "pack",
    name: "10-Race Pack",
    raceCount: 10,
    price: 111.95, // $11.20/race — 25.12% off
    depositKindId: RACE_SIM_DEPOSIT_KIND.anytime,
    pctOff: 25,
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
  if (!product || !raceSimProductBookable(product)) return false;
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

/**
 * Thrown by guard 2f when a picked session wants a circuit that its time slot
 * is already locked to something else for. Four rigs, one pool: a 10:00
 * session runs ONE circuit, so whoever booked it first fixed which. The guest
 * who picked second has to move to that circuit or to another time — and they
 * must hear it BEFORE the charge, which is why this is a guard and not a
 * day-of conversation at the desk.
 *
 * `lockedTo` is the stable track key, so the caller can name the circuit in
 * the guest's own locale rather than hardcoding a name here.
 */
export class RaceSimCircuitTakenError extends Error {
  readonly code = "RACESIM_CIRCUIT_TAKEN" as const;
  constructor(
    readonly slot: string,
    readonly lockedTo: RaceSimTrackKey,
  ) {
    super(
      "That session is already running a different circuit — " +
        "pick that circuit or choose another time.",
    );
    this.name = "RaceSimCircuitTakenError";
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
