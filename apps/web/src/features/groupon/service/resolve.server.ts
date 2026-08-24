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
import { fetchUnit, redeemUnit, isGrouponConfigured, isNotOurVoucher } from "../client.server";
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

// Shapes moved to ../codes so the kiosk classifier (a CLIENT module) can match
// them without importing this file and dragging the signing key toward the
// browser bundle. Re-exported so existing importers are unaffected.
export {
  GROUPON_CODE_RE,
  GROUPON_LONG_CODE_RE,
  normalizeGrouponCode,
  looksLikeGrouponCode,
} from "../codes";
// A re-export creates no local binding, and this module calls it below.
import { normalizeGrouponCode } from "../codes";

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
 * deliberately a separate call (see `redeemGrouponUnit`) so the read path stays
 * non-destructive and a rescan never re-redeems.
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
    if (!res.ok && !isNotOurVoucher(res.errorCodes)) {
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

  // 3. PERSIST FIRST — and this ordering is not cosmetic. The row IS the
  //    entitlement: the instant we tell Groupon `redeemed`, their copy stops
  //    being the truth and this table is the only record of the guest's five
  //    legs. Redeeming before writing would risk a voucher that Groupon calls
  //    spent and we have never heard of.
  const row = await upsertGrouponUnit({
    redemptionCode: unit.redemptionCode || code,
    unitId: unit.id,
    grouponCode: unit.grouponCode,
    dealKey,
    items,
    valueAmount: unit.value?.amount ?? null,
    currencyCode: unit.value?.currencyCode ?? null,
  });

  // 4. REDEEM NOW, at scan (owner 2026-08-20). Non-fatal by construction: the
  //    guest's legs are already ours to honour, so a failed PATCH leaves the row
  //    `pending` for the sweep and changes nothing the guest can see. This is
  //    also why a rescan on another kiosk is harmless — step 1 answers it from
  //    the ledger and never asks Groupon again.
  // The result is deliberately not branched on: `items` is what the guest can
  // take and the row already holds it. A failed PATCH is our bookkeeping problem
  // (the sweep's), never a reason to show them less.
  await redeemGrouponRow(row, unit);
  return viewOf(row, true);
}

/**
 * Tell Groupon the voucher is used. DESTRUCTIVE and irreversible.
 *
 * Called AT SCAN, straight after the ledger row is written (owner 2026-08-20:
 * "I want to redeem with groupon soon as its scanned... then it converts to our
 * tables"). The earlier design deferred this until a leg was delivered, to avoid
 * burning a voucher when a dispenser jammed — but that protection is redundant
 * here: the ledger row already owes the guest all five legs regardless of what
 * Groupon thinks, and a rescan is answered locally. Deferring only bought a
 * window in which our books and Groupon's disagreed.
 *
 * Idempotent three ways over: a row already `sent` returns immediately, the
 * re-fetch below sees `redeemed` and short-circuits, and Groupon independently
 * refuses a second PATCH with INVALID_STATE_TRANSITION.
 *
 * RE-FETCH, NEVER RECONSTRUCT. The PATCH only works by echoing the unit exactly
 * as the GET returned it (see client.server.ts). Building one from ledger
 * columns cannot do that: this table stores `value` but not `price`, so a
 * reconstructed unit sends a price Groupon never quoted — a real prod unit
 * carries price 3060 against our fabricated 0. Groupon answers a mutated echo
 * with UNIT_NOT_FOUND / MALFORMED_REQUEST, which the failure path treats as
 * TERMINAL, so one bad echo would permanently strand a row.
 *
 */
export async function redeemGrouponUnit(code: string): Promise<{ redeemed: boolean }> {
  const row = await findGrouponUnit(normalizeGrouponCode(code));
  if (!row) return { redeemed: false };
  return redeemGrouponRow(row);
}

/**
 * The redeem itself, against a row the caller already holds.
 *
 * Separate from the lookup because the scan path has just written this row: a
 * second read would be wasted, and worse, it would make the redeem depend on
 * read-after-write visibility for a row created microseconds earlier.
 */
export async function redeemGrouponRow(
  row: GrouponUnitRow,
  /**
   * The unit as a GET just returned it, when the caller already has one. This is
   * NOT the reconstruction the doc above forbids — it is the genuine echo, taken
   * from a fetch moments earlier — and it saves the guest standing at the kiosk
   * a whole round-trip on the scan path. The cron has no unit and re-fetches.
   */
  known?: GrouponUnit,
): Promise<{ redeemed: boolean }> {
  if (row.redeemState === "sent") return { redeemed: true };

  let fetched;
  if (known) {
    fetched = { data: [known], errorCodes: [] as string[], raw: "" };
  } else {
    try {
      fetched = await fetchUnit(row.redemptionCode);
    } catch (e) {
      await markGrouponRedeemFailure(row.redemptionCode, `refetch: ${String(e)}`, false);
      return { redeemed: false };
    }
  }

  const unit: GrouponUnit | null = fetched.data?.[0] ?? null;
  if (!unit) {
    // Only Groupon positively denying the unit exists is terminal. Anything
    // else — a flake, a 5xx, an empty envelope — stays pending for the cron,
    // because we have already handed the guest something.
    await markGrouponRedeemFailure(
      row.redemptionCode,
      `refetch: ${fetched.raw.slice(0, 400)}`,
      // Terminal. If we cannot FETCH the unit we can never echo it, so we can
      // never redeem it — park it for a human instead of hammering the sweep.
      isNotOurVoucher(fetched.errorCodes),
    );
    return { redeemed: false };
  }

  // Already spent upstream — the obligation is discharged, so record it and
  // send nothing. Covers a crash between PATCH and ledger write.
  if (unit.status === "redeemed") {
    await markGrouponRedeemed(row.redemptionCode);
    return { redeemed: true };
  }

  // Neither `available` nor `redeemed` (refunded, expired, whatever Groupon
  // adds next). We do not know what a PATCH means against it, so we do not
  // guess — a human looks at it.
  if (unit.status !== "available") {
    await markGrouponRedeemFailure(row.redemptionCode, `refetch status: ${unit.status}`, true);
    return { redeemed: false };
  }

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

  const terminal = isNotOurVoucher(res.errorCodes) || res.errorCodes.includes("MALFORMED_REQUEST");
  await markGrouponRedeemFailure(row.redemptionCode, res.raw.slice(0, 500), terminal);
  return { redeemed: false };
}
