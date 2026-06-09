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
];

/** Look up a pack by slug. Returns undefined for an unknown slug. */
export function getRacePack(slug: string): RacePack | undefined {
  return RACE_PACKS.find((p) => p.slug === slug);
}

/** Receipt / line-item label, e.g. "5-Race Pack (Mon-Thu)". v1 parity (packLabel). */
export function racePackLabel(pack: RacePack): string {
  return `${pack.name} (${pack.dayType === "weekday" ? "Mon-Thu" : "Anytime"})`;
}
