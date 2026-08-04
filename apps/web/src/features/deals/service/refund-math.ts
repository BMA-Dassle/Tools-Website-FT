/**
 * How much of a deal purchase is still refundable, and which packs to take back.
 *
 * PURE. No database, no Square, no clock. Every number a refund modal shows and
 * every pack a refund selects is decided here, so it can be tested exhaustively
 * — which matters more than usual, because the failure modes are "gave away
 * value the guest already used" and "refused a refund the guest was owed".
 *
 * WHOLE PACKS ONLY. Square returns integer units of an order line, and a deal
 * order is exactly one line with `quantity: qty`. A sub-pack refund is not
 * expressible in the API at all — this is a hard constraint, not a simplification.
 */

import { ATTRACTIONS } from "@/lib/attractions-data";
import type { VoucherItem } from "~/features/game-cards/data/vouchers-db";
import { gameZoneItemDollars, type DealLocationKey } from "../catalog";
import { packLegMap, packUnitKey, type PackLegs } from "./pack-legs";

/**
 * What each leg of ONE pack is worth, pro-rata, summing EXACTLY to the price paid
 * for one pack.
 *
 * NOT `price / legCount`. A gel pack is [gel, gel, gz150, gz150] and 150 tokens
 * ($15) is worth more than a battle ($12) — splitting evenly would tell staff a
 * guest who burned both token legs had used half the pack when they had used
 * more, and the refund would be too generous by real money.
 *
 * TAKES THE ITEMS AND THE PRICE, NOT THE CATALOG ENTRY. Both are now
 * purchase-specific:
 *
 *   - a limited-time offer appends BONUS items, frozen on the row at purchase, so
 *     a pack's leg count is not `deal.items.length`
 *   - deal pricing is dynamic, so `deal.priceCents` is today's price and not
 *     necessarily what this buyer paid
 *
 * Deriving either from the live catalog would mis-price every refund of a sale
 * made during an offer.
 *
 * Weights still come from the live catalog — that is a comparison of what things
 * are worth, not of what was charged. The ACTIVATION FEE `dealValue` adds for
 * marketing comparison is excluded: a waived fee is not consumable value, and
 * counting it would understate how much of a pack a guest actually burned.
 *
 * The last leg absorbs the rounding remainder so no cent is created or lost.
 */
export function legPaidCents(args: {
  /** One pack's items, INCLUDING any frozen bonus items. */
  items: readonly VoucherItem[];
  location: DealLocationKey;
  /** What one pack actually cost this buyer, pre-tax. */
  pricePaidCents: number;
  /** For error messages only. */
  dealSlug: string;
}): number[] {
  const { items, location, pricePaidCents, dealSlug } = args;
  if (items.length === 0) throw new Error(`deal ${dealSlug}: a pack with no items has no legs`);
  const weights = items.map((item) => legWeightCents(dealSlug, item, location));
  const total = weights.reduce((a, b) => a + b, 0);
  if (total <= 0) {
    throw new Error(`deal ${dealSlug}: cannot weight legs — total à-la-carte value is zero`);
  }
  const out = weights.map((w) => Math.round((pricePaidCents * w) / total));
  out[out.length - 1] += pricePaidCents - out.reduce((a, b) => a + b, 0);
  return out;
}

function legWeightCents(dealSlug: string, item: VoucherItem, location: DealLocationKey): number {
  if (item.kind === "gamezone") return Math.round(gameZoneItemDollars(item) * 100);
  if (item.kind === "attraction") {
    const product = ATTRACTIONS[item.slug]?.products.find((p) => p.location === location);
    if (!product) {
      // Loud, exactly like dealValue: a pack offered where its attraction has no
      // price is a catalog error, and guessing a weight here would quietly
      // mis-price every refund of it.
      throw new Error(`deal ${dealSlug}: no ${item.slug} product at ${location}`);
    }
    return Math.round(product.price * 100) * item.qty;
  }
  throw new Error(`deal ${dealSlug}: cannot weight a leg of kind "${item.kind}"`);
}

export interface PackState extends PackLegs {
  /** Slots (0..L-1) within this pack whose legs are gone. */
  spentSlots: number[];
  /** Pre-tax value the guest has already consumed from this pack. */
  spentCents: number;
  /** Pre-tax value still on this pack. */
  unspentCents: number;
  fullyUnspent: boolean;
  /** Already returned by an earlier refund — not selectable again. */
  alreadyRefunded: boolean;
  unitKey: string;
  unitLabel: string;
}

/**
 * Per-pack state, given which legs each code has lost.
 *
 * `spentByCode` should come from `spentItemIndexes`, which counts `claimed` AND
 * `spent` — matching the claim CAS's predicate. If this read and that statement
 * ever disagree, two parts of the system disagree about the same voucher.
 */
export function packStates(args: {
  /** One pack's items, INCLUDING frozen bonus items — this is what sets the
   *  leg count, and it is NOT `deal.items.length` for an offer purchase. */
  items: readonly VoucherItem[];
  location: DealLocationKey;
  /** What one pack actually cost, pre-tax. */
  pricePaidCents: number;
  dealSlug: string;
  combine: boolean;
  qty: number;
  codes: string[];
  spentByCode: Map<string, Set<number>>;
  /** Pack indexes an earlier refund already took back. */
  refundedPackIndexes?: number[];
}): PackState[] {
  const legValues = legPaidCents({
    items: args.items,
    location: args.location,
    pricePaidCents: args.pricePaidCents,
    dealSlug: args.dealSlug,
  });
  const L = args.items.length;
  const refunded = new Set(args.refundedPackIndexes ?? []);

  return packLegMap({
    combine: args.combine,
    qty: args.qty,
    codes: args.codes,
    itemsPerPack: L,
  }).map((pack) => {
    const spentOnCode = args.spentByCode.get(pack.code) ?? new Set<number>();
    const spentSlots = pack.legIndexes
      .map((legIndex, slot) => (spentOnCode.has(legIndex) ? slot : -1))
      .filter((slot) => slot >= 0);
    const spentCents = spentSlots.reduce((sum, slot) => sum + legValues[slot], 0);
    return {
      ...pack,
      spentSlots,
      spentCents,
      unspentCents: args.pricePaidCents - spentCents,
      fullyUnspent: spentSlots.length === 0,
      alreadyRefunded: refunded.has(pack.pack),
      unitKey: packUnitKey(pack.code, pack.pack),
      unitLabel:
        args.qty > 1 ? `Pack ${pack.pack + 1} of ${args.qty} · ${pack.code}` : `Pack · ${pack.code}`,
    };
  });
}

export interface PackSelection {
  packIndexes: number[];
  unitKeys: string[];
  /** Pre-tax value being returned that the guest ALREADY USED. */
  spentValueIncludedCents: number;
  /** True when the selection reaches past the untouched packs. */
  needsOverride: boolean;
  fullyUnspentPacks: number;
  refundablePacks: number;
}

/**
 * Which `k` packs to take back.
 *
 * Fully-unspent packs first, ascending, then the LEAST-spent of the rest. Two
 * reasons: it returns the most value for the least given away, and it makes the
 * default selection (`k = fullyUnspentPacks`) exactly "refund what they never
 * used", which is the owner's rule.
 */
export function choosePacksToRefund(states: PackState[], k: number, override = false): PackSelection {
  const available = states.filter((s) => !s.alreadyRefunded);
  const clean = available.filter((s) => s.fullyUnspent).sort((a, b) => a.pack - b.pack);
  const dirty = available
    .filter((s) => !s.fullyUnspent)
    .sort((a, b) => a.spentCents - b.spentCents || a.pack - b.pack);

  const chosen = [...clean, ...dirty].slice(0, Math.max(0, k));
  const spentValueIncludedCents = chosen.reduce((n, s) => n + s.spentCents, 0);

  return {
    packIndexes: chosen.map((s) => s.pack),
    unitKeys: chosen.map((s) => s.unitKey),
    spentValueIncludedCents,
    needsOverride: spentValueIncludedCents > 0 && !override,
    fullyUnspentPacks: clean.length,
    refundablePacks: available.length,
  };
}

/** Resolve an explicit unit-key selection back to packs, ignoring unknown keys. */
export function selectPacksByUnitKey(states: PackState[], unitKeys: string[]): PackState[] {
  const wanted = new Set(unitKeys);
  return states.filter((s) => wanted.has(s.unitKey) && !s.alreadyRefunded);
}

/**
 * How many packs of a purchase still count against the buyer's cap.
 *
 * A partial refund gives back exactly the packs it returned; a void zeroes the
 * whole row (the guest kept nothing). `Math.max(0, …)` so a data bug can never
 * hand out negative allowance.
 */
export function allowanceConsumed(row: {
  qty: number;
  refundedPacks: number;
  vouchersVoidedAt: string | null;
}): number {
  if (row.vouchersVoidedAt) return 0;
  return Math.max(0, row.qty - row.refundedPacks);
}

/**
 * A human sentence about what refunding this selection gives away.
 *
 * Returns null when nothing has been used — the modal shows no warning at all
 * rather than a reassuring one nobody reads.
 */
export function spentWarning(
  chosen: PackState[],
  totalPaidCents: number,
  qty: number,
): string | null {
  const dirty = chosen.filter((s) => !s.fullyUnspent);
  if (dirty.length === 0) return null;
  const usedCents = dirty.reduce((n, s) => n + s.spentCents, 0);
  const legs = dirty.reduce((n, s) => n + s.spentSlots.length, 0);
  return (
    `${dirty.length} of the ${qty} pack${qty === 1 ? "" : "s"} you are refunding ` +
    `${dirty.length === 1 ? "has" : "have"} already been partly used — ` +
    `${legs} item${legs === 1 ? "" : "s"} worth ${dollars(usedCents)} of the ${dollars(totalPaidCents)} paid. ` +
    `Refunding ${dirty.length === 1 ? "it" : "them"} returns value the guest already took.`
  );
}

const dollars = (cents: number): string => `$${(cents / 100).toFixed(2)}`;
