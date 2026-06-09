/**
 * Kids Bowl Free / Families Bowl Free pricing math — the SINGLE source of
 * truth shared by the charge path (app/api/bowling/v2/reserve/route.ts) and
 * the display path (BowlingOfferStep card + CheckoutStep review summary).
 *
 * Why this exists: the VIP lane upcharge and adult game fees used to live only
 * in the reserve route, so the UI showed "$0.00 / Free" for a VIP package the
 * customer was actually charged for. Per the repo rule "ALWAYS pair displayed
 * price with charge-time re-eval," both sides now compute from these functions
 * so they can never drift.
 *
 * Rules:
 *   - Kids Bowl Free: kids bowl free; non-FBF adults pay per game.
 *   - Families Bowl Free: everyone (kids + family adults) bowls free.
 *   - VIP: +$1/game per person for ALL bowlers. Free bowlers (kids + FBF
 *     adults) incur a $2/person lane upcharge; paid adults get VIP baked into
 *     their per-game rate ($6/$7 instead of $5/$6).
 */

/** Two games per KBF session. */
export const KBF_GAMES_PER_SESSION = 2;

/** VIP lane upcharge: $1 per person per game. */
export const KBF_VIP_PER_GAME_CENTS = 100;

/** VIP lane upcharge per free bowler: $1/game × 2 games = $2.00. */
export const KBF_VIP_LANE_UPCHARGE_PER_PERSON_CENTS =
  KBF_VIP_PER_GAME_CENTS * KBF_GAMES_PER_SESSION;

/**
 * Per-game price for a PAID adult (Kids Bowl Free, non-FBF adult).
 * Friday is $1 higher; VIP is $1 higher.
 *   Mon–Thu: $5 ($6 VIP).  Fri–Sun: $6 ($7 VIP).
 */
export function kbfAdultPerGameCents(isVip: boolean, isFriday: boolean): number {
  return isFriday ? (isVip ? 700 : 600) : isVip ? 600 : 500;
}

/** Total paid-adult game charge: count × per-game × 2 games. */
export function kbfAdultGamesTotalCents(
  paidAdultCount: number,
  isVip: boolean,
  isFriday: boolean,
): number {
  return paidAdultCount * kbfAdultPerGameCents(isVip, isFriday) * KBF_GAMES_PER_SESSION;
}

/** Total VIP lane upcharge across all FREE bowlers (kids + FBF adults). $0 when not VIP. */
export function kbfVipUpchargeTotalCents(freeBowlerCount: number, isVip: boolean): number {
  return isVip ? freeBowlerCount * KBF_VIP_LANE_UPCHARGE_PER_PERSON_CENTS : 0;
}

/** True when the booked date (YYYY-MM-DD) falls on a Friday in local terms. */
export function isFridayYmd(ymd: string): boolean {
  return new Date(`${ymd}T12:00:00`).getDay() === 5;
}

// ── Square catalog IDs for KBF extra line items ─────────────────────────────
// Kept here (not in the route) so the quote (display) and reserve (charge)
// build byte-identical line items.
const ADULT_GAME_CATALOG_MON_THU = "55HD24QD6W2D5566EATRXIO4";
const ADULT_GAME_CATALOG_FRI = "PS37ALSQJQTTK7FSWFTROQ36";
const ADULT_GAME_VIP_CATALOG_MON_THU = "FN2JBP462OGS7ABTOL42VIK4";
const ADULT_GAME_VIP_CATALOG_FRI = "G67DSSE3MUARHUMMVP632Q6R";
export const KBF_VIP_CATALOG = "VOTDI26ES5J7TCHDEZ24JNEN"; // Kids Bowl Free VIP (2)
export const FBF_VIP_CATALOG = "KGFEKTF57JT5SE55JVVV2NEJ"; // Families Bowl Free VIP (2)

export function kbfAdultGameCatalogId(isVip: boolean, isFriday: boolean): string {
  return isVip
    ? isFriday
      ? ADULT_GAME_VIP_CATALOG_FRI
      : ADULT_GAME_VIP_CATALOG_MON_THU
    : isFriday
      ? ADULT_GAME_CATALOG_FRI
      : ADULT_GAME_CATALOG_MON_THU;
}

export function kbfAdultGameLabel(isVip: boolean, isFriday: boolean): string {
  return isVip
    ? isFriday
      ? "Adult Game Fri-Sun VIP"
      : "Adult Game Mon-Thur VIP"
    : isFriday
      ? "Adult Game Fri-Sun"
      : "Adult Game Mon-Thur";
}

/** A Square order line item in the shape both /quote and the reserve route use. */
export interface KbfSquareLineItem {
  name: string;
  quantity: string;
  basePriceMoney: { amount: number; currency: "USD" };
  catalogObjectId: string;
}

/**
 * The KBF "extra" Square line items beyond the free games: paid-adult game
 * fees + the VIP lane upcharge (split into KBF-kid vs FBF-adult lines for
 * catalog-linked reporting). Used by BOTH the quote endpoint (so the displayed
 * tax-inclusive total is exact) and the reserve route (the charge) — one
 * builder, so the quoted order and the charged order can't diverge.
 */
export function buildKbfExtraSquareLineItems(params: {
  isVip: boolean;
  isFriday: boolean;
  /** Free KBF kids (relation "kid"). */
  kbfKidCount: number;
  /** Free FBF adults (relation "family"). */
  fbfAdultCount: number;
  /** Paid (non-free) adults. */
  paidAdultCount: number;
}): KbfSquareLineItem[] {
  const { isVip, isFriday, kbfKidCount, fbfAdultCount, paidAdultCount } = params;
  const lines: KbfSquareLineItem[] = [];

  if (paidAdultCount > 0) {
    lines.push({
      name: kbfAdultGameLabel(isVip, isFriday),
      quantity: String(paidAdultCount * KBF_GAMES_PER_SESSION),
      basePriceMoney: { amount: kbfAdultPerGameCents(isVip, isFriday), currency: "USD" },
      catalogObjectId: kbfAdultGameCatalogId(isVip, isFriday),
    });
  }

  if (isVip) {
    if (kbfKidCount > 0) {
      lines.push({
        name: "Kids Bowl Free VIP",
        quantity: String(kbfKidCount),
        basePriceMoney: { amount: KBF_VIP_LANE_UPCHARGE_PER_PERSON_CENTS, currency: "USD" },
        catalogObjectId: KBF_VIP_CATALOG,
      });
    }
    if (fbfAdultCount > 0) {
      lines.push({
        name: "Families Bowl Free VIP",
        quantity: String(fbfAdultCount),
        basePriceMoney: { amount: KBF_VIP_LANE_UPCHARGE_PER_PERSON_CENTS, currency: "USD" },
        catalogObjectId: FBF_VIP_CATALOG,
      });
    }
  }

  return lines;
}
