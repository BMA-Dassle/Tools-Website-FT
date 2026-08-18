/**
 * Groupon deal → what we actually grant.
 *
 * THE RULE: this mapping is DATA WE WRITE DOWN, never text we parse. Groupon's
 * "$25 Worth of Arcade Game Play and Four Laser Tag Entries" is marketing copy.
 * Inferring value from a vendor's prose is exactly the mistake the BMI
 * comp-name path already taught us (see vouchers/grants.ts) — there the damage
 * was bounded by a denomination allowlist; here we simply never parse at all.
 *
 * SHAPE (owner 2026-08-18): the $25 lands whole on ONE card as bonus tokens,
 * plus four laser tag entries. Five independently-claimable items, so a guest
 * can take the card today and bring three friends back for laser tag on
 * Saturday. That is the entire reason the voucher model claims per
 * (code, item_index) rather than per code.
 *
 * (An earlier reading split the $25 across four cards, which at our 10¢/token
 * rate is 62.5 tokens per card — not an integer. One card avoids inventing a
 * rounding rule nobody agreed to.)
 */

import type { VoucherItem } from "~/features/game-cards/data/vouchers-db";
import type { GrouponUnit } from "./types";

/** Our own key for a Groupon deal. Stable, ours, never Groupon's marketing title. */
export type GrouponDealKey = "arcade25-laser4";

export interface GrouponDeal {
  key: GrouponDealKey;
  /** Staff-facing only. NEVER used to derive value. */
  description: string;
  items: VoucherItem[];
}

/**
 * $25 of arcade play = 250 bonus tokens at our 10¢/token rate — the same rate
 * that makes a "$15 game card" 150 tokens in the deal packs. 250 had to be
 * added to BOTH denomination allowlists (COMP_TOKEN_DENOMINATIONS and
 * NATIVE_GRANT_DENOMINATIONS) or this voucher would mint happily and then
 * credit NOTHING when the card was dispensed.
 */
export const GROUPON_DEALS: Record<GrouponDealKey, GrouponDeal> = {
  "arcade25-laser4": {
    key: "arcade25-laser4",
    description: "$25 Worth of Arcade Game Play and Four Laser Tag Entries",
    items: [
      { kind: "gamezone", tokens: 0, bonusTokens: 250, bonusCashDollars: 0 },
      { kind: "attraction", slug: "laser-tag", qty: 1 },
      { kind: "attraction", slug: "laser-tag", qty: 1 },
      { kind: "attraction", slug: "laser-tag", qty: 1 },
      { kind: "attraction", slug: "laser-tag", qty: 1 },
    ],
  },
};

/**
 * Which deal is this unit?
 *
 * KNOWN GAP: the GET response carries NO deal identifier — `attributes` is null
 * on every unit we have seen, and `value`/`price` on the staging units are
 * placeholder 100/1. So there is currently nothing on the wire to key on.
 *
 * While exactly one Groupon deal is live, the honest implementation is an
 * explicit default rather than a fake inference: we return the single
 * configured deal and say so. The moment a SECOND deal ships, this must key on
 * something real (populated `attributes`, or a per-deal config name) — and
 * until then `null` from here means "grant nothing", not "guess".
 */
// The unit is the input this WILL key on once Groupon gives us a deal
// identifier; keeping it in the signature now means adding that logic later
// never touches a call site.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function resolveDealKey(unit: GrouponUnit): GrouponDealKey | null {
  const keys = Object.keys(GROUPON_DEALS) as GrouponDealKey[];
  return keys.length === 1 ? keys[0] : null;
}

export function itemsForDeal(key: GrouponDealKey | null): VoucherItem[] | null {
  if (!key) return null;
  return GROUPON_DEALS[key]?.items ?? null;
}
