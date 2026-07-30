/**
 * BMI voucher redemption — pure coverage math (no DB / no network).
 *
 * Redemption model, verified by the live probes of 2026-07-27
 * (scripts/bmi-voucher-probe.mts; findings in
 * tasks/future/kiosk-coupons-vouchers.md §4):
 *
 *   - BMI `order/applyCode` puts the voucher's comp product on the bill as a
 *     $0 LINE ("Race Comp ×1", voucherCode-stamped). It does NOT discount the
 *     existing lines — BMI nets the comp against the matching line when the
 *     order is PROCESSED (owner-confirmed POS behavior).
 *   - Codes are NOT locked at apply, and cancelling the bill releases them.
 *   - A bill whose only line is the comp AUTO-CANCELS (probed live), so bills
 *     stay lazily created; vouchers chase the session's current bill.
 *
 * MULTIPLE vouchers are first-class (owner 2026-07-27): a party can scan one
 * comp per racer. `planVoucherCoverage` allocates deterministically, in SCAN
 * ORDER: each race-targeted voucher covers ONE single-race heat (cheapest
 * eligible first; packages/combo-packs never); each attraction-targeted
 * voucher covers ONE unit of the cheapest matching AttractionItem (stacking
 * up to the item's qty). The SAME plan feeds the charge (unified-reserve) and
 * every display — displayed can never drift from charged. Unknown comp names
 * cover NOTHING (never guess with money).
 */

import type {
  AppliedVoucherState,
  AttractionItem,
  BookingSession,
  RaceHeatAssignment,
  RaceItem,
} from "../state/types";
import { packageIdForCategory } from "../state/types";
import { getRaceProductById } from "./race-products";
import { promoFactor } from "./promo-pricing";
import {
  gameCardGrantFromCompName,
  type GameCardGrant,
} from "~/features/game-cards/vouchers/grants";

export type { AppliedVoucherState } from "../state/types";

/**
 * BMI voucher number shape: 12 strictly-alternating letter/digit pairs.
 * Confirmed invariant across a 32-code production batch (2026-07-27): letters
 * from a lookalike-free set, digits 2-9 (never 0/1). Shared by the kiosk scan
 * classifier AND the web checkout promo input.
 */
export const BMI_VOUCHER_RE = /^(?:[A-Z][2-9]){12}$/;

/**
 * Voucher redemption ENTRY flag — OPT-IN, defaults OFF. Gates only the entry
 * points (kiosk code-entry accept + web checkout promo-input branch); the
 * pricing/charge seams key on session vouchers existing, which only a gated
 * entry can set. Preview opt-in without env:
 * /kiosk/flow?kioskPromo=1&kioskVoucher=1. MUST stay dark until the paid live
 * smoke proves BMI's netting at processing.
 */
export function voucherRedeemEnabled(): boolean {
  return process.env.NEXT_PUBLIC_VOUCHER_REDEEM === "true";
}

/** Reserve-time hard fail: the session claims a voucher our server-side
 *  ledger never recorded for its bill. Never silently charge full price the
 *  guest didn't see. */
export class VoucherNotVerifiedError extends Error {
  constructor(code: string) {
    super(`voucher ${code} is not verified for this order`);
    this.name = "VoucherNotVerifiedError";
  }
}

/** The session's vouchers, scan order preserved. */
export function sessionVouchers(session: BookingSession): AppliedVoucherState[] {
  return session.appliedVouchers ?? [];
}

/** True once a voucher is actually ON a BMI bill (comp line exists). */
export function voucherIsApplied(v: AppliedVoucherState | null | undefined): boolean {
  if (!v || v.pending || v.error) return false;
  // Native vouchers are "applied" without a BMI bill — the coverage plan prices
  // them from `name` + `itemIndex`, and the reserve claims them at charge. BMI
  // vouchers still require the bill + comp-line id exactly as before.
  if (v.issuer === "native") return typeof v.itemIndex === "number";
  return !!v.billId && !!v.voucherOrderItemId;
}

/**
 * What a voucher's comp product pays for, parsed from its BMI line name
 * ("Race Comp", "Complimentary 1 Hour Shuffly", "Laser Comp", ...).
 */
export type VoucherTarget =
  | { kind: "race" }
  | { kind: "attraction"; slugs: string[] }
  /**
   * Game Zone card comp. Deliberately NOT a cart target: there is no line to
   * discount and no BMI money leg to net (see grants.ts header). It is
   * fulfilled by dispensing a card on the Game Zone rail, so the cart covers
   * nothing and the kiosk ROUTES the guest instead of saying "doesn't match
   * your cart". Carries the grant so the caller never re-parses the name.
   */
  | { kind: "gamecard"; grant: GameCardGrant }
  | { kind: "unknown" };

export function voucherTarget(name: string | null | undefined): VoucherTarget {
  const n = (name ?? "").toLowerCase();
  // Game Zone FIRST — its matcher is strict (`Complimentary <N> Token Game
  // Card`), so testing it before the loose keyword matches below can never
  // steal a race/attraction comp, while the reverse order could: a future
  // "Complimentary Duckpin Game Card" must stay on the attraction rail.
  const gameCard = gameCardGrantFromCompName(name);
  if (gameCard) return { kind: "gamecard", grant: gameCard };
  if (n.includes("race")) return { kind: "race" };
  if (n.includes("laser")) return { kind: "attraction", slugs: ["laser-tag"] };
  if (n.includes("gel")) return { kind: "attraction", slugs: ["gel-blaster"] };
  if (n.includes("shuf")) return { kind: "attraction", slugs: ["shuffly"] };
  if (n.includes("duck")) return { kind: "attraction", slugs: ["duck-pin"] };
  return { kind: "unknown" };
}

/**
 * Short, consistent label for a comp — BMI's line "name" is whatever the
 * voucher SETUP is called, and in production that ranges from a tidy
 * "Race Comp" to a full instruction sentence ("Complimentary Gel Blasters.
 * Redeem on a kiosk or at guest services." — live 2026-07-28). Never render
 * the raw string in chips/lines; derive from the matched target instead, and
 * fall back to the first clause (capped) for names we can't map.
 *
 * These are product labels, not UI copy — untranslated, same rule as combo /
 * product proper nouns elsewhere in the kiosk.
 */
const ATTRACTION_COMP_LABEL: Record<string, string> = {
  "gel-blaster": "Gel Blaster comp",
  "laser-tag": "Laser Tag comp",
  shuffly: "Shuffly comp",
  "duck-pin": "Duckpin comp",
};

export function voucherDisplayName(name: string | null | undefined): string {
  const target = voucherTarget(name);
  if (target.kind === "race") return "Race comp";
  if (target.kind === "gamecard") return `${target.grant.bonusTokens} Token Game Card comp`;
  if (target.kind === "attraction") {
    return ATTRACTION_COMP_LABEL[target.slugs[0]] ?? "Comp";
  }
  const first = (name ?? "").split(/[.!\r\n]/)[0].trim();
  if (!first) return "Voucher";
  return first.length > 26 ? `${first.slice(0, 25).trimEnd()}…` : first;
}

export interface VoucherPick {
  code: string;
  name?: string;
  /** The single-race heat this voucher covers (race target). */
  raceHeat?: RaceHeatAssignment;
  /** The AttractionItem (+ discounted unit price) this voucher covers. */
  attractionItemId?: string;
  attractionUnitCents?: number;
}

export interface VoucherCoveragePlan {
  /** Race heats to join excludedHeats (charge $0 — the credits/packs rail). */
  raceHeats: Set<RaceHeatAssignment>;
  /** AttractionItem id → covered unit count (Square quantity reduction). */
  attractionUnits: Map<string, number>;
  /** Per-voucher allocation, scan order — display lines + no-match notes. */
  picks: VoucherPick[];
}

const EMPTY_PLAN: VoucherCoveragePlan = {
  raceHeats: new Set(),
  attractionUnits: new Map(),
  picks: [],
};

/**
 * Allocate every APPLIED voucher (pending/errored ones price nothing), in
 * scan order, against the session's cart. `baseExcluded` = heats already
 * covered by credits/packs — those win first; vouchers never double-cover.
 * Deterministic: cheapest eligible pick per voucher, ties → earliest heat /
 * first cart item.
 */
export function planVoucherCoverage(
  session: BookingSession,
  baseExcluded: ReadonlySet<RaceHeatAssignment>,
): VoucherCoveragePlan {
  const vouchers = sessionVouchers(session).filter(voucherIsApplied);
  if (vouchers.length === 0) return EMPTY_PLAN;

  const raceHeats = new Set<RaceHeatAssignment>();
  const attractionUnits = new Map<string, number>();
  const picks: VoucherPick[] = [];

  for (const v of vouchers) {
    const target = voucherTarget(v.name);
    const pick: VoucherPick = { code: v.code, name: v.name };

    if (target.kind === "race") {
      const heat = cheapestUncoveredHeat(session, baseExcluded, raceHeats);
      if (heat) {
        raceHeats.add(heat);
        pick.raceHeat = heat;
      }
    } else if (target.kind === "attraction") {
      const found = cheapestUncoveredAttractionUnit(session, target.slugs, attractionUnits);
      if (found) {
        attractionUnits.set(found.itemId, (attractionUnits.get(found.itemId) ?? 0) + 1);
        pick.attractionItemId = found.itemId;
        pick.attractionUnitCents = found.cents;
      }
    } else if (target.kind === "gamecard") {
      // Allocates NOTHING, deliberately. A Game Zone comp is fulfilled by
      // dispensing a card with Intercard value on it (see
      // game-cards/vouchers/grants.ts), not by discounting a cart line — the
      // guest still owes full price for everything else in the cart. Routing
      // happens at the kiosk / /api/game-cards/voucher-redeem; this rail must
      // never price it. Do not "fix" this into a discount.
    }
    picks.push(pick);
  }
  return { raceHeats, attractionUnits, picks };
}

function cheapestUncoveredHeat(
  session: BookingSession,
  baseExcluded: ReadonlySet<RaceHeatAssignment>,
  alreadyPicked: ReadonlySet<RaceHeatAssignment>,
): RaceHeatAssignment | null {
  let best: { heat: RaceHeatAssignment; price: number; start: string } | null = null;
  for (const item of session.items) {
    if (item.kind !== "race") continue;
    const race = item as RaceItem;
    for (const heat of race.heats) {
      if (!heat.heatId || baseExcluded.has(heat) || alreadyPicked.has(heat)) continue;
      const category = heat.category ?? "adult";
      if (packageIdForCategory(race, category)) continue;
      const pid =
        heat.productId ?? (category === "adult" ? race.productIdAdult : race.productIdJunior);
      if (!pid) continue;
      const product = getRaceProductById(pid);
      if (!product || product.packType === "combo") continue;
      const start = heat.heatId;
      if (
        !best ||
        product.price < best.price ||
        (product.price === best.price && start < best.start)
      ) {
        best = { heat, price: product.price, start };
      }
    }
  }
  return best?.heat ?? null;
}

function cheapestUncoveredAttractionUnit(
  session: BookingSession,
  slugs: string[],
  covered: ReadonlyMap<string, number>,
): { itemId: string; cents: number } | null {
  let best: { itemId: string; cents: number } | null = null;
  for (const item of session.items) {
    if (item.kind !== "attraction") continue;
    const attr = item as AttractionItem;
    if (!attr.slug || !slugs.includes(attr.slug)) continue;
    if (!attr.productId || attr.qty < 1) continue;
    if ((covered.get(attr.id) ?? 0) >= attr.qty) continue; // fully covered already
    const fullUnitCents = Math.round(attr.price * 100);
    const factor = promoFactor(
      { domain: "attractions", visitDate: attr.date ?? undefined, productSlug: attr.slug },
      session.appliedPromo ?? null,
    );
    const cents = factor === 1 ? fullUnitCents : Math.round(fullUnitCents * factor);
    if (cents <= 0) continue;
    if (!best || cents < best.cents) best = { itemId: attr.id, cents };
  }
  return best;
}

/**
 * Per-voucher review amounts — one negative line each, derived by
 * DIFFERENCING the same race line-builder the charge uses (heats removed one
 * pick at a time, in scan order) + the plan's attraction unit price. An
 * amount of 0 = that voucher matched nothing in the cart.
 */
export function voucherReviewLines(
  session: BookingSession,
  baseExcluded: ReadonlySet<RaceHeatAssignment>,
  sumRaceLines: (ex: Set<RaceHeatAssignment>) => number,
): Array<{ code: string; name?: string; amount: number }> {
  const plan = planVoucherCoverage(session, baseExcluded);
  if (plan.picks.length === 0) return [];
  const excluded = new Set(baseExcluded);
  let before = plan.raceHeats.size > 0 ? sumRaceLines(excluded) : 0;
  return plan.picks.map((p) => {
    let amount = 0;
    if (p.raceHeat) {
      excluded.add(p.raceHeat);
      const after = sumRaceLines(excluded);
      amount = Math.round((before - after) * 100) / 100;
      before = after;
    } else if (p.attractionUnitCents) {
      amount = p.attractionUnitCents / 100;
    }
    return { code: p.code, name: p.name, amount: Math.max(0, amount) };
  });
}
