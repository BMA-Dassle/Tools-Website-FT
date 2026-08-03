/**
 * Finish paid deal purchases the live request didn't get to.
 *
 * The purchase path deliberately soft-fails after capture, so two states are
 * both normal and both recoverable:
 *
 *   charged, no `voucher_batch_id`  → money taken, vouchers never cut
 *   minted, never `sent`           → codes exist, the buyer wasn't emailed
 *
 * `fulfilDealPurchase` handles both and is safe to call repeatedly — the mint is
 * fenced by a conditional UPDATE, so a race with the live request mints nothing
 * extra and voids any surplus. This sweep is therefore just "find them and call
 * it", which is why it holds no logic of its own.
 *
 * The `olderThanSeconds` grace exists so the cron never fights a request that is
 * still mid-flight: a purchase that captured two seconds ago is very likely
 * being fulfilled right now.
 *
 * IT ALSO RELEASES SCHEDULED GIFTS. A gift bought for a future date is minted and
 * receipted at purchase, then parked in `scheduled` until `gift_send_at`. This
 * sweep is what wakes it up — no separate cron, because the work is the same work
 * (finish a paid purchase) and a second schedule is a second thing to forget.
 * At `10,40 * * * *` a gift timed for 8:00 AM ET goes out by 8:10, which is well
 * inside what "on the day" means to a recipient.
 */

import { listDueGiftDeliveries, listUnfinishedDealPurchases } from "../data/deal-purchases-db";
import { fulfilDealPurchase } from "./purchase";

/** Don't touch a purchase younger than this — the request may still be working. */
const GRACE_SECONDS = 180;

export interface DealSweepSummary {
  scanned: number;
  minted: number;
  emailed: number;
  stillPending: number;
  /** Purchase ids that remain unfinished after this pass, for alerting. */
  unresolved: number[];
  /** Scheduled gifts whose day arrived and were delivered on this pass. */
  giftsDelivered: number;
  /** Due gifts that failed to deliver — the next pass retries them. */
  giftsFailed: number[];
}

export async function sweepUnfulfilledDealPurchases(
  opts: { dryRun?: boolean } = {},
): Promise<DealSweepSummary> {
  const rows = await listUnfinishedDealPurchases(GRACE_SECONDS);
  const due = await listDueGiftDeliveries();
  const summary: DealSweepSummary = {
    scanned: rows.length + due.length,
    minted: 0,
    emailed: 0,
    stillPending: 0,
    unresolved: [],
    giftsDelivered: 0,
    giftsFailed: [],
  };
  if (opts.dryRun) {
    summary.stillPending = rows.length;
    summary.unresolved = rows.map((r) => r.id);
    summary.giftsFailed = due.map((r) => r.id);
    return summary;
  }

  for (const row of rows) {
    const hadCodes = row.codes.length > 0;
    try {
      const res = await fulfilDealPurchase(row);
      if (!hadCodes && res.codes.length > 0) summary.minted += 1;
      if (!res.emailPending) summary.emailed += 1;
      if (res.mintPending || res.emailPending) {
        summary.stillPending += 1;
        summary.unresolved.push(row.id);
      }
    } catch (err) {
      // One bad row must not stop the sweep — the next pass retries it.
      console.error(`[deal-reconcile] purchase ${row.id} failed:`, err);
      summary.stillPending += 1;
      summary.unresolved.push(row.id);
    }
  }

  /* ── scheduled gifts whose day has come ────────────────────────────────
     Same `fulfilDealPurchase`, no second delivery implementation: the row is
     already minted, so it walks straight past the mint and into the delivery
     branch, and the future-date gate no longer holds because the date is now in
     the past. `markDealPurchaseSent` moves it scheduled → sent, so a gift can
     only ever be released once. */
  for (const row of due) {
    try {
      const res = await fulfilDealPurchase(row);
      if (res.emailPending || res.mintPending) summary.giftsFailed.push(row.id);
      else summary.giftsDelivered += 1;
    } catch (err) {
      console.error(`[deal-reconcile] gift ${row.id} delivery failed:`, err);
      summary.giftsFailed.push(row.id);
    }
  }

  if (summary.unresolved.length > 0) {
    console.error(
      `[deal-reconcile] ${summary.unresolved.length} paid purchase(s) still unfulfilled: ${summary.unresolved.join(", ")}`,
    );
  }
  if (summary.giftsFailed.length > 0) {
    console.error(
      `[deal-reconcile] ${summary.giftsFailed.length} due gift(s) undelivered: ${summary.giftsFailed.join(", ")}`,
    );
  }
  return summary;
}
