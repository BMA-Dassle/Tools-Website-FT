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
  /**
   * Face values (`unit.value.amount`, minor units) OBSERVED on units of this
   * deal. A SENTINEL, not a price: nothing here is charged, displayed, or used
   * to compute what the guest gets — `items` alone decides that. Its only job
   * is to notice that a unit is not the deal we think it is.
   *
   * Written down from live responses, never inferred:
   *   6500 — production, unit 23cc45c6 (2026-08-20).
   *    100 — the `headpinz-preprod` placeholder every staging unit carries.
   */
  valueAmounts: number[];
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
    valueAmounts: [6500, 100],
  },
};

/**
 * Which deal is this unit?
 *
 * KNOWN GAP, now confirmed in BOTH environments: the GET carries NO deal
 * identifier. `attributes` is null on every unit we have seen, staging AND
 * production (checked 2026-08-20 against a real purchased voucher). So there is
 * nothing authoritative on the wire to key on, and there may never be.
 *
 * With one deal configured the honest answer is still an explicit default, not
 * a fake inference. What changed is that we no longer accept that default
 * BLINDLY: production units carry a real `value` (staging's was a placeholder),
 * so a unit whose face value is not one we have ever recorded for this deal is
 * refused rather than granted. That converts the failure mode from "silently
 * hands a second deal's guest the wrong five items" into "refuses, loudly, and
 * someone adds the deal" — recoverable instead of a money loss in either
 * direction.
 *
 * `null` from here always means GRANT NOTHING. It never means guess.
 */
export function resolveDealKey(unit: GrouponUnit): GrouponDealKey | null {
  const keys = Object.keys(GROUPON_DEALS) as GrouponDealKey[];
  if (keys.length !== 1) return null;

  const only = GROUPON_DEALS[keys[0]];
  const amount = unit.value?.amount;
  // No value on the wire at all — fall back to the single-deal default rather
  // than refusing a voucher over a field Groupon simply did not send.
  if (typeof amount !== "number") return only.key;

  return only.valueAmounts.includes(amount) ? only.key : null;
}

export function itemsForDeal(key: GrouponDealKey | null): VoucherItem[] | null {
  if (!key) return null;
  return GROUPON_DEALS[key]?.items ?? null;
}
