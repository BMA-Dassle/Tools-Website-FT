/**
 * Race-pack catalog (v2).
 *
 * A race-pack is a PREPAID BUNDLE OF RACE CREDITS — not a booking. The customer
 * pays one price and N race credits load onto their BMI/Pandora deposit ledger,
 * to be redeemed later at $0/heat in the normal race flow (the redeem side lives
 * in service/race-credit-redeem.ts + data/race-credits.ts).
 *
 * Ported from v1 `app/book/race-packs/page.tsx`; the values below are verified
 * 1:1 against that source (PACKS array, RACE_PACK_DEPOSIT_KIND, the shared Square
 * catalog id). Pack composition lives HERE in code, NEVER in Square — Square only
 * carries the pack slug (per tasks/future/race-pack-as-credit-purchase.md).
 *
 * The deposit-kind ids match the REDEEM side exactly (data/race-credits.ts
 * RACE_CREDIT_TYPES + lib/pandora-deposits.ts DEPOSIT_KIND), so a pack bought
 * here grants credits the v2 race checkout can spend.
 */
import { etOffsetForLocalDate } from "@/lib/et-time";

/** Pandora deposit-kind ids that race credits load onto. */
export const RACE_PACK_DEPOSIT_KIND = {
  weekday: "12744867", // Race-credit Mon-Thu
  anytime: "12744871", // Race-credit any day
} as const;

/**
 * Single shared Square catalog item for EVERY pack variant. The human-readable
 * variant label ("5-Race Pack (Mon-Thu)") is applied as a per-order line-item
 * name override at charge time. v1 parity (SQUARE_RACE_PACK_CATALOG_ID).
 */
export const SQUARE_RACE_PACK_CATALOG_ID = "YYOV5QCHQSJKZS7DDIALGU7Z";

export type RacePackDayType = "weekday" | "anytime";

export interface RacePack {
  /** Stable URL/cart key, e.g. "5-race-weekday". */
  slug: string;
  /** Display name without the day qualifier, e.g. "5-Race Pack". */
  name: string;
  /** Credits granted = number of race heats this pack covers. */
  raceCount: number;
  /** weekday = Mon–Thu only; anytime = any day. */
  dayType: RacePackDayType;
  /** Sticker price in USD, pre-tax. */
  price: number;
  /** Pandora deposit-kind id the granted credits load onto. */
  depositKindId: string;
  /**
   * v1 BMI productId for the legacy `booking/sell` path. The v2 flow charges via
   * Square + Pandora addDeposit (the live v1 path) and does NOT use this; kept for
   * traceability against the v1 catalog.
   */
  bmiProductId: string;
  /**
   * Restricts WHO may buy this pack, by racer tier. Omitted = any racer (every
   * pre-2026-08-12 pack). Set on the BOGO sale SKUs, which are priced off the
   * adult ($20.99) vs junior ($15.99) single-race rate: without this, an adult
   * could buy the cheaper junior pack and redeem its credits against adult
   * heats. Enforced server-side (fail-closed) in `resolveKioskPacks`, not just
   * hidden in the UI — the session carries slug pointers a client could forge.
   */
  category?: "adult" | "junior";
  /**
   * Restricts WHO may buy this pack by racer history. Omitted = any racer
   * (every pre-2026-08-12 pack — new racers have always been able to buy a
   * standing 3/5/10 pack).
   *
   * `"existing"` on the BOGO sale SKUs, because the sale ships in two halves:
   * returning racers get these credits, while NEW racers get the equivalent
   * offer as the `bogo-weekday` PACKAGE (lib/packages.ts), which books both
   * heats outright. A new racer must not be able to take both — and a credit
   * is the wrong instrument for them anyway, since redemption requires
   * `bmiPersonId && !isNewRacer` and would refuse them in-session.
   */
  racerType?: "new" | "existing";
  /**
   * Undiscounted value of the same credits, for a was/now strikethrough. Only
   * set on sale SKUs; display-only and NEVER charged (the charge always reads
   * `price`). BOGO = 2 × the single-race rate.
   */
  regularPrice?: number;
  /** Short marketing flag rendered on the sell surfaces, e.g. "FLASH SALE". */
  badge?: string;
}

/**
 * BOGO flash sale — buy one race, get one WEEKDAY race credit free (owner
 * 2026-08-12). Ends END OF DAY Thu 2026-08-13 Eastern.
 *
 * The credits land on the Mon–Thu kind (`RACE_PACK_DEPOSIT_KIND.weekday` =
 * the "Weekday Race Credit" type in data/race-credits.ts), so the free race is
 * already day-locked to Mon–Thu by the existing redeem rail — no new deposit
 * kind and no new restriction logic.
 *
 * WINDOW = PURCHASE TIME, not race date. It gates BOTH the sell surfaces and
 * `resolveKioskPacks`'s fail-closed slug check (they share one slug list), so
 * after the deadline the slug is simply not sellable — no separate teardown
 * step, and a stale client that still renders the tile gets a server refusal.
 */
export const BOGO_SALE_ENDS_AT = "2026-08-13T23:59:59";

/** Slugs the sale adds to the catalog while it runs. */
export const BOGO_SALE_SLUGS = ["bogo-races-adult", "bogo-races-junior"] as const;

/**
 * Is the flash sale live at `now`? ET wall-clock via `etOffsetForLocalDate`
 * (never a hardcoded offset — that is the Dec-19 6pm→5pm bug).
 *
 * THROWS on a malformed deadline rather than returning a boolean: an Invalid
 * Date compares false against everything, so a typo here would silently read as
 * "sale already over" and the SKUs would never appear at all.
 */
export function bogoSaleActive(now: Date = new Date()): boolean {
  const ends = new Date(`${BOGO_SALE_ENDS_AT}${etOffsetForLocalDate(BOGO_SALE_ENDS_AT)}`);
  if (Number.isNaN(ends.getTime())) {
    throw new Error(`BOGO_SALE_ENDS_AT is not a valid date: ${BOGO_SALE_ENDS_AT}`);
  }
  return now.getTime() <= ends.getTime();
}

export const RACE_PACKS: RacePack[] = [
  {
    slug: "3-race-weekday",
    name: "3-Race Pack",
    raceCount: 3,
    dayType: "weekday",
    price: 49.99,
    depositKindId: RACE_PACK_DEPOSIT_KIND.weekday,
    bmiProductId: "13079165",
  },
  {
    slug: "3-race-anytime",
    name: "3-Race Pack",
    raceCount: 3,
    dayType: "anytime",
    price: 59.99,
    depositKindId: RACE_PACK_DEPOSIT_KIND.anytime,
    bmiProductId: "13079678",
  },
  {
    slug: "5-race-weekday",
    name: "5-Race Pack",
    raceCount: 5,
    dayType: "weekday",
    price: 79.99,
    depositKindId: RACE_PACK_DEPOSIT_KIND.weekday,
    bmiProductId: "12754550",
  },
  {
    slug: "5-race-anytime",
    name: "5-Race Pack",
    raceCount: 5,
    dayType: "anytime",
    price: 99.99,
    depositKindId: RACE_PACK_DEPOSIT_KIND.anytime,
    bmiProductId: "13079686",
  },
  {
    slug: "10-race-weekday",
    name: "10-Race Pack",
    raceCount: 10,
    dayType: "weekday",
    price: 159.99,
    depositKindId: RACE_PACK_DEPOSIT_KIND.weekday,
    bmiProductId: "12754573",
  },
  {
    slug: "10-race-anytime",
    name: "10-Race Pack",
    raceCount: 10,
    dayType: "anytime",
    price: 199.99,
    depositKindId: RACE_PACK_DEPOSIT_KIND.anytime,
    bmiProductId: "13079694",
  },
  // ── BOGO flash sale (2026-08-12 → EOD 2026-08-13) ─────────────────────────
  // Two races for the price of one, priced off the SINGLE-RACE rate for each
  // tier (adult $20.99 / junior $15.99 in service/race-products.ts), so each
  // tier gets a true buy-one-get-one rather than one flat price that would
  // shortchange juniors. `category` is what stops an adult buying the cheaper
  // junior SKU. Sold only while `bogoSaleActive()` — see BOGO_SALE_SLUGS.
  //
  // No bmiProductId: these are v2-only SKUs with no v1 `booking/sell`
  // equivalent, and that field is traceability-only (the v2 rail charges via
  // Square + Pandora addDeposit).
  {
    slug: "bogo-races-adult",
    name: "BOGO Races",
    raceCount: 2,
    dayType: "weekday",
    price: 20.99,
    regularPrice: 41.98,
    badge: "FLASH SALE",
    category: "adult",
    racerType: "existing",
    depositKindId: RACE_PACK_DEPOSIT_KIND.weekday,
    bmiProductId: "",
  },
  {
    slug: "bogo-races-junior",
    name: "BOGO Races",
    raceCount: 2,
    dayType: "weekday",
    price: 15.99,
    regularPrice: 31.98,
    badge: "FLASH SALE",
    category: "junior",
    racerType: "existing",
    depositKindId: RACE_PACK_DEPOSIT_KIND.weekday,
    bmiProductId: "",
  },
];

/** Look up a pack by slug. Returns undefined for an unknown slug. */
export function getRacePack(slug: string): RacePack | undefined {
  return RACE_PACKS.find((p) => p.slug === slug);
}

/**
 * Receipt / line-item label, e.g. "5-Race Pack (Mon-Thu)". v1 parity (packLabel).
 *
 * A category-restricted pack names its tier ("BOGO Races Junior (Mon-Thu)").
 * The adult and junior BOGO SKUs otherwise share a name AND a day type, so the
 * Square line-item override and the race_pack_purchases ledger row could not be
 * told apart in the books. Packs without a `category` (every pre-sale SKU) are
 * byte-identical to before.
 */
export function racePackLabel(pack: RacePack): string {
  const day = pack.dayType === "weekday" ? "Mon-Thu" : "Anytime";
  const tier = pack.category === "junior" ? " Junior" : "";
  return `${pack.name}${tier} (${day})`;
}
