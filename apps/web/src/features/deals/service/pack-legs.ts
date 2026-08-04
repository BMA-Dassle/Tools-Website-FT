/**
 * Which voucher legs belong to which PACK.
 *
 * A deal purchase is sold in packs, but it mints legs. `dealVoucherItems` builds
 * a combined voucher by flattening `Array.from({length: n}, () => deal.items)`,
 * so the ordering is PACK-MAJOR: pack 0's legs, then pack 1's, and so on. That
 * single fact is what makes the mapping tractable, and getting it backwards is
 * the most expensive bug available in this area — you would tell staff a pack is
 * untouched while its legs are already redeemed, and refund it.
 *
 * Two shapes, because `combine` decides how many codes exist:
 *
 *   combine = true   ONE code carries every pack.
 *                    leg i → pack floor(i / L), slot i % L
 *   combine = false  ONE code per pack, each a fresh `deal.items`.
 *                    codes[j] IS pack j, slots restart at 0
 *
 * Pure and dependency-free so it can be exhaustively tested without a database
 * or a Square client — see `pack-legs.test.ts`.
 */

export interface PackLegs {
  /** 0-based pack number within the purchase. */
  pack: number;
  code: string;
  /** Indexes into THAT code's item array. */
  legIndexes: number[];
}

export class PackShapeError extends Error {}

/**
 * Assert the codes match the shape the purchase claims to have.
 *
 * Throws rather than guessing. A purchase whose `combine`/`qty`/`codes` disagree
 * has no defined pack↔leg mapping, and every downstream answer — how much is
 * unspent, which legs to void, how much to refund — would be invented.
 */
export function assertPackShape(args: { combine: boolean; qty: number; codes: string[] }): void {
  const { combine, qty, codes } = args;
  if (codes.length === 0) throw new PackShapeError("no voucher codes on this purchase");
  if (combine && codes.length !== 1) {
    throw new PackShapeError(`combined purchase has ${codes.length} codes, expected 1`);
  }
  if (!combine && codes.length !== qty) {
    throw new PackShapeError(`split purchase has ${codes.length} codes, expected ${qty}`);
  }
}

/** Every pack in the purchase, with the legs that belong to it. */
export function packLegMap(args: {
  combine: boolean;
  qty: number;
  codes: string[];
  /** Legs in ONE pack — `deal.items.length`. */
  itemsPerPack: number;
}): PackLegs[] {
  const { combine, qty, codes, itemsPerPack: L } = args;
  assertPackShape(args);
  if (L <= 0) throw new PackShapeError("a pack with no items has no legs to map");

  return Array.from({ length: qty }, (_, pack) =>
    combine
      ? { pack, code: codes[0], legIndexes: Array.from({ length: L }, (_, slot) => pack * L + slot) }
      : { pack, code: codes[pack], legIndexes: Array.from({ length: L }, (_, slot) => slot) },
  );
}

/**
 * The inverse: which pack a given leg on a given code belongs to.
 *
 * `codeIndex` is that code's position in `codes` — ignored when combined, where
 * there is only one code and the pack lives in the leg index instead.
 */
export function packOfLeg(args: {
  combine: boolean;
  legIndex: number;
  codeIndex: number;
  itemsPerPack: number;
}): number {
  const { combine, legIndex, codeIndex, itemsPerPack: L } = args;
  if (L <= 0) throw new PackShapeError("a pack with no items has no legs to map");
  return combine ? Math.floor(legIndex / L) : codeIndex;
}

/** Human label for a pack — "Pack 2 of 3", or just the product when there is one. */
export function packLabel(pack: number, qty: number): string {
  return qty > 1 ? `Pack ${pack + 1} of ${qty}` : "Pack";
}

/**
 * The stable handle a refund selects by.
 *
 * Includes the code because a split purchase's packs live on different codes,
 * and includes the pack because a combined purchase's packs share one. Neither
 * alone is unique across both shapes.
 */
export function packUnitKey(code: string, pack: number): string {
  return `${code}#p${pack}`;
}
