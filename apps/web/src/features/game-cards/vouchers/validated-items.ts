/**
 * How one line of voucher value is presented to a redeeming surface — PURE.
 *
 * Extracted from `service/native-voucher.ts` so a SECOND issuer (Groupon) maps
 * its items through exactly this code instead of a parallel copy. The two must
 * not drift: `coverageName` is matched by the booking's `voucherTarget()`, so a
 * second issuer inventing "Lasertag" where this one says "Laser Tag" would
 * produce a voucher that validates, shows the guest a laser tag line, and then
 * silently covers nothing at checkout. One mapper, one spelling.
 *
 * Pure and issuer-agnostic on purpose: it takes an item plus its identity and
 * label, and knows nothing about where either came from.
 */

import { type VoucherItem, voucherItemLabel } from "../data/vouchers-db";

/**
 * One UNSPENT item on a scanned voucher, told apart by where it's redeemed:
 *   gamezone → dispense a card / credit one (the Game Zone rail)
 *   cart     → covers a race heat or an attraction unit at booking checkout
 * `coverageName` is the string the booking's voucherTarget() keys off
 * ("Race" / "Laser Tag" / …).
 */
export interface ValidatedItem {
  index: number;
  redeemVia: "gamezone" | "cart";
  label: string;
  coverageName?: string;
  /** Game-zone items: total tokens (purchased + bonus) — drives the "$ in play"
   *  value shown on the receipt. Omitted for cart items. */
  tokens?: number;
}

/** Booking coverage name for a cart item — must satisfy voucherTarget(). */
export function cartCoverageName(slugOrRace: string): string {
  switch (slugOrRace) {
    case "race":
      return "Race";
    case "laser-tag":
      return "Laser Tag";
    case "gel-blaster":
      return "Gel Blaster";
    case "shuffly":
      return "Shuffly";
    case "duck-pin":
      return "Duckpin";
    default:
      return slugOrRace;
  }
}

/** Coverage name for a whole item — a choice item joins its options with "or"
 *  so voucherTarget() sees every keyword ("Laser Tag or Gel Blaster" matches
 *  the combined laser+gel branch and covers whichever is in the cart). */
export function cartCoverageNameForItem(item: VoucherItem): string {
  if (item.kind === "race") return cartCoverageName("race");
  if (item.kind === "attraction") return cartCoverageName(item.slug);
  if (item.kind === "attraction-choice") {
    return item.slugs.map(cartCoverageName).join(" or ");
  }
  return "";
}

/**
 * Present one item at a given index. `label` is injectable because the native
 * rail already computed it when it read the voucher row; callers without one
 * get `voucherItemLabel`, which is the same function that produced it.
 */
export function toValidatedItem(item: VoucherItem, index: number, label?: string): ValidatedItem {
  const text = label ?? voucherItemLabel(item);
  if (item.kind === "gamezone") {
    return {
      index,
      redeemVia: "gamezone",
      label: text,
      tokens: item.tokens + item.bonusTokens,
    };
  }
  return {
    index,
    redeemVia: "cart",
    label: text,
    coverageName: cartCoverageNameForItem(item),
  };
}
