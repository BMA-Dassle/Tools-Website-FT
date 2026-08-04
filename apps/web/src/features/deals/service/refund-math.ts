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
import { gameZoneItemDollars, type DealCatalogEntry, type DealLocationKey } from "../catalog";
import { packLegMap, packUnitKey, type PackLegs } from "./pack-legs";

/**
 * What each leg of ONE pack is worth, pro-rata, summing EXACTLY to the pre-tax
 * pack price.
 *
 * NOT `priceCents / legCount`. A laser pack is [laser, laser, gz100, gz100] and
 * a laser session is worth more than $10 of tokens — splitting evenly would tell
 * staff a guest who burned both laser sessions had used half the pack when they
 * had used most of it, and the refund would be too generous by real money.
 *
 * Weights come from the live catalog, the same sources `dealValue` uses, so a
 * price change moves both together. The ACTIVATION FEE that `dealValue` adds for
 * marketing comparison is excluded: a waived fee is not consumable value, and
 * counting it would understate how much of a pack a guest actually burned.
 *
 * The last leg absorbs the rounding remainder so no cent is created or lost.
 */
export function legPaidCents(deal: DealCatalogEntry, location: DealLocationKey): number[] {
  const weights = deal.items.map((item) => legWeightCents(deal, item, location));
  const total = weights.reduce((a, b) => a + b, 0);
  if (total <= 0) {
    throw new Error(`deal ${deal.slug}: cannot weight legs — total à-la-carte value is zero`);
  }
  const out = weights.map((w) => Math.round((deal.priceCents * w) / total));
  out[out.length - 1] += deal.priceCents - out.reduce((a, b) => a + b, 0);
  return out;
}

function legWeightCents(
  deal: DealCatalogEntry,
  item: VoucherItem,
  location: DealLocationKey,
): number {
  if (item.kind === "gamezone") return Math.round(gameZoneItemDollars(item) * 100);
  if (item.kind === "attraction") {
    const product = ATTRACTIONS[item.slug]?.products.find((p) => p.location === location);
    if (!product) {
      // Loud, exactly like dealValue: a pack offered where its attraction has no
      // price is a catalog error, and guessing a weight here would quietly
      // mis-price every refund of it.
      throw new Error(`deal ${deal.slug}: no ${item.slug} product at ${location}`);
    }
    return Math.round(product.price * 100) * item.qty;
  }
  throw new Error(`deal ${deal.slug}: cannot weight a leg of kind "${item.kind}"`);
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
  deal: DealCatalogEntry;
  location: DealLocationKey;
  combine: boolean;
  qty: number;
  codes: string[];
  spentByCode: Map<string, Set<number>>;
  /** Pack indexes an earlier refund already took back. */
  refundedPackIndexes?: number[];
}): PackState[] {
  const legValues = legPaidCents(args.deal, args.location);
  const L = args.deal.items.length;
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
      unspentCents: args.deal.priceCents - spentCents,
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
