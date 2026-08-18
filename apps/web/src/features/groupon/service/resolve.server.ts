/**
 * Groupon code → what this guest can still take. SERVER ONLY.
 *
 * RESOLUTION ORDER IS THE WHOLE POINT, and it is local-first:
 *
 *   1. `groupon_units` — have we seen this code before?
 *   2. only if not, ask Groupon.
 *
 * Inverting those two is the bug this feature is most likely to ship. Groupon
 * reports a unit `redeemed` from the moment we redeem it, which is the FIRST
 * scan — so an API-first resolver tells a guest holding four unspent laser tag
 * entries that their voucher is "already used". The local row is the truth
 * about what is left; Groupon's copy only ever answers "did this voucher exist
 * and was it live when we first saw it".
 *
 * The corollary is the one case we must NOT be generous about: `redeemed` at
 * Groupon with NO local row means it was spent somewhere that is not us. That
 * refuses.
 */

import {
  findGrouponUnit,
  upsertGrouponUnit,
  markGrouponRedeemed,
  markGrouponRedeemFailure,
  type GrouponUnitRow,
} from "../data/groupon-units-db";
import { fetchUnit, redeemUnit, isGrouponConfigured } from "../client.server";
import { itemsForDeal, resolveDealKey } from "../deals";
import { spentItemIndexes } from "~/features/game-cards/data/voucher-claims-db";
import type { VoucherItem } from "~/features/game-cards/data/vouchers-db";
import type { GrouponRefusal, GrouponUnit } from "../types";

/** One line of a Groupon voucher plus whether it is still available. */
export interface GrouponItemView {
  itemIndex: number;
  item: VoucherItem;
  spent: boolean;
}

export type GrouponResolution =
  | {
      ok: true;
      code: string;
      row: GrouponUnitRow;
      items: GrouponItemView[];
      /** Nothing left to take — every line is claimed or spent. */
      fullySpent: boolean;
      /** True the first time we see this code (nothing handed over yet). */
      firstScan: boolean;
    }
  | { ok: false; refusal: GrouponRefusal; detail?: string };

/** Groupon's short code: 8 alphanumerics, e.g. `WNDXH4DJ`. */
export const GROUPON_CODE_RE = /^[A-Z0-9]{8}$/;
/** The printed/emailed form: `VS-XXXX-XXXX-XXXX-XXXX`. Unambiguous. */
export const GROUPON_LONG_CODE_RE = /^VS(?:-[A-Z0-9]{4}){4}$/;

export function normalizeGrouponCode(raw: string): string {
  return raw.trim().toUpperCase().replace(/\s+/g, "");
}

/** Could this string be a Groupon code at all? Cheap pre-filter, not authority. */
export function looksLikeGrouponCode(raw: string): boolean {
  const c = normalizeGrouponCode(raw);
  return GROUPON_CODE_RE.test(c) || GROUPON_LONG_CODE_RE.test(c);
}

async function viewOf(row: GrouponUnitRow, firstScan: boolean): Promise<GrouponResolution> {
  const spent = await spentItemIndexes(row.redemptionCode);
  const items = row.items.map((item, itemIndex) => ({
    itemIndex,
    item,
    spent: spent.has(itemIndex),
  }));
  return {
    ok: true,
    code: row.redemptionCode,
    row,
    items,
    fullySpent: items.length > 0 && items.every((i) => i.spent),
    firstScan,
  };
}

/**
 * Resolve a Groupon code. NON-DESTRUCTIVE — this never redeems. Redemption is
 * deliberately a separate, later call (see `redeemAfterDelivery`) so we cannot
 * burn a guest's voucher before they have actually been given anything.
 */
export async function resolveGrouponCode(rawCode: string): Promise<GrouponResolution> {
  const code = normalizeGrouponCode(rawCode);

  // 1. LOCAL FIRST. A known code is answered entirely from our ledger — no
  //    network call, so a Groupon outage cannot strand a returning guest.
  const existing = await findGrouponUnit(code);
  if (existing) return viewOf(existing, false);

  if (!isGrouponConfigured()) return { ok: false, refusal: "unavailable" };

  // 2. Unknown to us — now ask Groupon.
  const res = await fetchUnit(code);
  const unit = res.data?.[0] ?? null;

  if (!unit) {
    // A transient flake must never read as "no such voucher"; the client
    // already retried UNKNOWN_ERROR, so anything non-OK left here is unavailable.
    if (!res.ok && !res.errorCodes.includes("UNIT_NOT_FOUND")) {
      return { ok: false, refusal: "unavailable", detail: res.raw.slice(0, 200) };
    }
    return { ok: false, refusal: "unknown" };
  }

  // Spent, and not by us. Refuse — and say when, so staff can reason about it.
  if (unit.status !== "available") {
    return { ok: false, refusal: "already_redeemed", detail: unit.redeemedAt ?? undefined };
  }

  const dealKey = resolveDealKey(unit);
  const items = itemsForDeal(dealKey);
  // Recognised but unmapped grants NOTHING. Never guess a deal's contents.
  if (!items || items.length === 0) return { ok: false, refusal: "unmapped" };

  // 3. PERSIST BEFORE ANY VALUE MOVES. From here on the guest's entitlement
  //    survives a Groupon outage, a crash, or a failed redeem.
  const row = await upsertGrouponUnit({
    redemptionCode: unit.redemptionCode || code,
    unitId: unit.id,
    grouponCode: unit.grouponCode,
    dealKey,
    items,
    valueAmount: unit.value?.amount ?? null,
    currencyCode: unit.value?.currencyCode ?? null,
  });

  return viewOf(row, true);
}

/**
 * Tell Groupon the voucher is used. Call this ONLY after the first item has
 * genuinely been delivered (a card left the stacker, or a cart claim was
 * captured).
 *
 * Ordering is a deliberate safety choice: redeeming at scan would eat a guest's
 * Groupon when the dispenser jams thirty seconds later. Redeeming after
 * delivery means the worst case is that WE owe Groupon a notification, which
 * the ledger records and the cron drives forward — a bookkeeping problem, not a
 * guest losing money.
 *
 * Idempotent by state: a row already `sent` returns immediately, and Groupon
 * independently refuses a second redeem with INVALID_STATE_TRANSITION.
 */
export async function redeemAfterDelivery(code: string): Promise<{ redeemed: boolean }> {
  const row = await findGrouponUnit(normalizeGrouponCode(code));
  if (!row) return { redeemed: false };
  if (row.redeemState === "sent") return { redeemed: true };

  const unit: GrouponUnit = {
    id: row.unitId,
    status: "available",
    grouponCode: row.grouponCode,
    redemptionCode: row.redemptionCode,
    redeemedAt: null,
    value: { amount: row.valueAmount ?? 0, currencyCode: row.currencyCode ?? "USD" },
    price: { amount: 0, currencyCode: row.currencyCode ?? "USD" },
    attributes: null,
  };

  let res;
  try {
    res = await redeemUnit(unit);
  } catch (e) {
    await markGrouponRedeemFailure(row.redemptionCode, String(e), false);
    return { redeemed: false };
  }

  if (res.ok) {
    await markGrouponRedeemed(row.redemptionCode);
    return { redeemed: true };
  }

  // Already redeemed at Groupon = the outcome we wanted. Treat as success, or
  // the cron retries forever against a verdict that will never change.
  if (res.errorCodes.includes("INVALID_STATE_TRANSITION")) {
    await markGrouponRedeemed(row.redemptionCode);
    return { redeemed: true };
  }

  const terminal =
    res.errorCodes.includes("UNIT_NOT_FOUND") || res.errorCodes.includes("MALFORMED_REQUEST");
  await markGrouponRedeemFailure(row.redemptionCode, res.raw.slice(0, 500), terminal);
  return { redeemed: false };
}
