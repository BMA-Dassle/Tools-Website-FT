/**
 * Claim a leg of a Groupon voucher. SERVER ONLY. DESTRUCTIVE.
 *
 * The deal is five independently-claimable legs — one game card plus four laser
 * tag entries — taken whenever the guest feels like it, possibly days apart. So
 * there are two rails here, and they are deliberately different:
 *
 *   GAME ZONE (claimGrouponGameZone)  → a card is dispensed. Claim now, credit
 *                                       at encode, tell Groupon after the card
 *                                       actually lands.
 *   CART (elsewhere, on purpose)      → the leg covers a booking line, claimed
 *                                       at charge time by
 *                                       `claimNativeCartVouchers`, which is
 *                                       issuer-aware. Deliberately NOT
 *                                       reimplemented here: that rail already
 *                                       owns expiry checks, leg substitution,
 *                                       idempotent reserve retries, release and
 *                                       the stale-claim sweep. A second writer
 *                                       for the same fact would drift from it.
 *
 * WHAT MAKES PARTIAL SAFE. Per-leg consumption lives in `voucher_claims`, whose
 * one-statement CAS is the single authority — the same table, and the same
 * atomic claim, the native rail uses. Two kiosks scanning the same Groupon at
 * the same moment therefore cannot both take the card: one wins the CAS. We do
 * NOT track spend in `groupon_units`; that would be a second writer for the
 * same fact and the two would drift the first time a claim failed halfway.
 *
 * WHAT MAKES IT PARTIAL AT ALL. Groupon is all-or-nothing — one `redeemed`
 * PATCH, ever. We send it once, after the FIRST leg is delivered, and from that
 * moment Groupon's copy stops being the truth and `groupon_units` +
 * `voucher_claims` are. That is why a guest can take the $25 card on Wednesday
 * and still walk in on Saturday with three friends for the laser tag.
 */

import { randomUUID } from "node:crypto";
import { claimVoucher, releaseVoucherClaim } from "~/features/game-cards/data/voucher-claims-db";
import { gameZoneGrant, voucherItemLabel } from "~/features/game-cards/data/vouchers-db";
import { VOUCHER_PACKAGE_PREFIX } from "~/features/game-cards/vouchers/grants";
import { startCompedTxn } from "~/features/game-cards/data/transactions-log";
import { spentItemIndexes } from "~/features/game-cards/data/voucher-claims-db";
import { findGrouponUnit } from "../data/groupon-units-db";
import { normalizeGrouponCode } from "../codes";
import type { GrouponRefusal } from "../types";

export type GrouponClaimRefusal = GrouponRefusal | "storage" | "not_redeemable";

export type GrouponGameZoneClaim =
  | {
      ok: true;
      txnId: string;
      groupId: string;
      grant: { tokens: number; bonusTokens: number; bonusCashDollars: number };
      label: string;
      itemIndex: number;
      packageId: string;
    }
  | { ok: false; reason: GrouponClaimRefusal };

/**
 * Take the game-card leg and stage the load.
 *
 * Ordering mirrors the native rail exactly: CLAIM FIRST, then the ledger row,
 * and release the claim if the ledger insert fails. A claim without a ledger
 * row is a leg the guest can never spend; a ledger row without a claim is a
 * card we might hand out twice.
 *
 * Groupon is NOT told here. The PATCH belongs after the card physically lands
 * (see `onGrouponCardDelivered`), because redeeming at claim time would eat a
 * guest's voucher when the stacker jams thirty seconds later.
 */
export async function claimGrouponGameZone(input: {
  code: string;
  locationCode: number;
  kioskId?: string | null;
  /** WEB only: credit a card the guest already holds instead of dispensing. */
  accountNumber?: string;
  source: "kiosk" | "web";
}): Promise<GrouponGameZoneClaim> {
  const code = normalizeGrouponCode(input.code);

  const row = await findGrouponUnit(code);
  // Never reach out to Groupon here. A claim is for a voucher we have already
  // validated and written down; an unknown code means the scan step was skipped.
  if (!row) return { ok: false, reason: "unknown" };

  let spent: Set<number>;
  try {
    spent = await spentItemIndexes(code);
  } catch (err) {
    console.error("[groupon] claim read failed:", err instanceof Error ? err.message : err);
    return { ok: false, reason: "storage" };
  }

  const gzLegs = row.items
    .map((item, index) => ({ item, index }))
    .filter((e) => e.item.kind === "gamezone");
  // A laser-tag-only voucher is live value we cannot fulfil on THIS rail. Say
  // so distinctly from "used" — the guest still has something, just not here.
  if (gzLegs.length === 0) return { ok: false, reason: "not_redeemable" };

  const pick = gzLegs.find((e) => !spent.has(e.index));
  if (!pick) return { ok: false, reason: "used" };

  const grant = gameZoneGrant(pick.item);
  if (!grant) return { ok: false, reason: "not_redeemable" };

  const txnId = randomUUID();
  const groupId = randomUUID();
  // Same `gzv-<tokens>` shape as the native rail so load-card and the reconcile
  // cron resolve every issuer through one code path.
  const packageId = `${VOUCHER_PACKAGE_PREFIX}${grant.bonusTokens}`;
  const label = voucherItemLabel(pick.item);

  let claimed: Awaited<ReturnType<typeof claimVoucher>>;
  try {
    claimed = await claimVoucher({
      code,
      itemIndex: pick.index,
      issuer: "groupon",
      compName: label,
      packageId,
      txnId,
      locationCode: input.locationCode,
      clientKey: null,
      kioskId: input.kioskId ?? null,
    });
  } catch (err) {
    console.error("[groupon] claim store unavailable:", err instanceof Error ? err.message : err);
    return { ok: false, reason: "storage" };
  }
  // Lost the CAS — another kiosk took this leg a moment ago.
  if (!claimed.ok) return { ok: false, reason: "used" };

  try {
    await startCompedTxn({
      txnId,
      groupId,
      // The kind encodes FULFILMENT: crediting a card the guest already holds
      // must never look like a fresh blank, or clear-on-encode would wipe their
      // existing balance.
      kind: input.accountNumber ? "voucher_reload" : "voucher",
      locationCode: input.locationCode,
      accountNumber: input.accountNumber ?? "",
      packageId,
      tokens: grant.tokens,
      bonusTokens: grant.bonusTokens,
      tpiTransactionId: `groupon-${txnId}`,
      voucherCode: code,
    });
  } catch (err) {
    await releaseVoucherClaim(code, txnId, "ledger row insert failed").catch(() => {});
    console.error("[groupon] ledger insert failed:", err instanceof Error ? err.message : err);
    return { ok: false, reason: "storage" };
  }

  return { ok: true, txnId, groupId, grant, label, itemIndex: pick.index, packageId };
}
