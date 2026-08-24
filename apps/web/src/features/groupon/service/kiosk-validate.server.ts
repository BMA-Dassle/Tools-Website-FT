/**
 * Groupon → the shape the kiosk code-entry screen already speaks. SERVER ONLY.
 *
 * WHY AN ADAPTER AND NOT A GROUPON PANEL. The kiosk already knows how to hold a
 * multi-item voucher: it splits items into `gamezone` legs (dispense a card) and
 * `cart` legs (cover a booking line), shows spent legs struck through so a
 * re-scan explains where a leg went, and has EN+ES copy for all of it. Groupon's
 * deal is exactly that shape — one card plus four laser tag entries. Building a
 * second panel would duplicate every one of those behaviours and then drift from
 * them; emitting the same `ValidatedItem[]` reuses them for free.
 *
 * NEVER CLAIMS A LEG. This only reads what the guest may take; the destructive
 * per-leg claim happens later, at dispense or at booking charge.
 *
 * It CAN redeem at Groupon, though, on a first scan — `resolveGrouponCode`
 * converts the voucher into our tables and reports it to Groupon immediately
 * (owner 2026-08-20). That is invisible here and irrelevant to the guest: from
 * the first scan onward the legs are ours to honour, and a rescan on any kiosk
 * is answered from the ledger with whatever is left.
 */

import { voucherItemLabel } from "~/features/game-cards/data/vouchers-db";
import {
  toValidatedItem,
  type ValidatedItem,
} from "~/features/game-cards/vouchers/validated-items";
import { resolveGrouponCode } from "./resolve.server";
import type { GrouponRefusal } from "../types";

export type GrouponValidateResult =
  | {
      ok: true;
      /** First unspent leg, for the "added" toast. Matches the native rail. */
      label: string;
      /** Every UNSPENT leg, routed by rail. */
      items: ValidatedItem[];
      /** Already-claimed legs — rendered struck through on the receipt. */
      spentItems: { index: number; label: string }[];
      /** True the first time we ever saw this code. */
      firstScan: boolean;
    }
  | { ok: false; reason: GrouponRefusal };

export async function validateGrouponForKiosk(code: string): Promise<GrouponValidateResult> {
  const res = await resolveGrouponCode(code);
  if (!res.ok) return { ok: false, reason: res.refusal };

  // Every leg taken. Distinct from "unknown" so the guest hears the truth: the
  // voucher was real and they have already had all five things.
  if (res.fullySpent) return { ok: false, reason: "used" };

  const items = res.items
    .filter((i) => !i.spent)
    // itemIndex is the claim identity in `voucher_claims` — it MUST survive the
    // mapping unchanged, or a claim would be recorded against the wrong leg.
    .map((i) => toValidatedItem(i.item, i.itemIndex));

  const spentItems = res.items
    .filter((i) => i.spent)
    .map((i) => ({ index: i.itemIndex, label: voucherItemLabel(i.item) }));

  // A row with no unspent legs but not `fullySpent` should be impossible; treat
  // it as used rather than showing an empty receipt.
  if (items.length === 0) return { ok: false, reason: "used" };

  return { ok: true, label: items[0].label, items, spentItems, firstScan: res.firstScan };
}
