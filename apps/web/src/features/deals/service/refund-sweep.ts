/**
 * Drive stalled refund attempts to a terminal state.
 *
 * Every non-terminal `deal_refunds` state is a request that reached Square (or
 * was about to) and then lost its process. Without a sweep the most likely one —
 * `crediting`, a gift-card refund whose credit posts in Square's batch a minute
 * later — parks forever, and the board keeps showing a refund that looks
 * unfinished when the money has actually landed.
 *
 * WHAT THIS DOES NOT DO: re-issue money. It re-reads Square and records what it
 * finds. The only reason replaying is safe elsewhere is the idempotency keys, and
 * a sweep that decided to "retry the refund" would be the one place capable of
 * paying twice. So `crediting` is resolved by LOOKING at the card balance, and
 * anything it cannot resolve is parked and reported, never guessed at.
 *
 * REPORTS ON EVERY RUN, including the quiet one. A sweep that goes silent when it
 * gives up is indistinguishable from a sweep with nothing to do.
 */

import {
  listStalledDealRefunds,
  recomputeDealRefundTotals,
  updateDealRefund,
  type DealRefundRow,
} from "../data/deal-refunds-db";

export interface RefundSweepDeps {
  /** Live balance on a gift card, or null when unreadable. */
  giftCardBalanceCents: (giftCardId: string) => Promise<number | null>;
  /** Square's current view of a refund. */
  refundStatus: (refundId: string) => Promise<{ status: string; amountCents: number } | null>;
}

export interface RefundSweepOutcome {
  refundId: number;
  purchaseId: number;
  state: DealRefundRow["state"];
  action: "settled" | "failed" | "still_pending" | "needs_human";
  detail: string;
}

export interface RefundSweepResult {
  scanned: number;
  settled: number;
  failed: number;
  stillPending: number;
  needsHuman: number;
  outcomes: RefundSweepOutcome[];
}

/** Attempts older than this with no resolution are a human's problem. */
export const ESCALATE_AFTER_MINUTES = 60;

export async function sweepDealRefunds(args: {
  deps: RefundSweepDeps;
  olderThanSeconds?: number;
  limit?: number;
  now?: number;
}): Promise<RefundSweepResult> {
  const rows = await listStalledDealRefunds(args.olderThanSeconds ?? 120, args.limit ?? 25);
  const now = args.now ?? Date.now();
  const result: RefundSweepResult = {
    scanned: rows.length,
    settled: 0,
    failed: 0,
    stillPending: 0,
    needsHuman: 0,
    outcomes: [],
  };

  for (const row of rows) {
    const ageMinutes = (now - Date.parse(row.createdAt)) / 60_000;
    const outcome = await resolveOne(row, ageMinutes, args.deps);
    result.outcomes.push(outcome);
    if (outcome.action === "settled") result.settled += 1;
    else if (outcome.action === "failed") result.failed += 1;
    else if (outcome.action === "needs_human") result.needsHuman += 1;
    else result.stillPending += 1;
  }

  return result;
}

async function resolveOne(
  row: DealRefundRow,
  ageMinutes: number,
  deps: RefundSweepDeps,
): Promise<RefundSweepOutcome> {
  const base = { refundId: row.id, purchaseId: row.purchaseId, state: row.state };
  const stale = ageMinutes >= ESCALATE_AFTER_MINUTES;

  // A refund id exists — Square is the authority on what happened to it.
  if (row.squareRefundId) {
    const facts = await deps.refundStatus(row.squareRefundId).catch(() => null);

    if (facts && (facts.status === "FAILED" || facts.status === "REJECTED")) {
      // Terminal and no money moved. The legs were already released by the
      // executor's abort path if it got that far; if the process died first they
      // stay held, which is why this is reported rather than silently closed.
      await updateDealRefund(row.id, {
        state: "failed",
        squareRefundStatus: facts.status,
        lastError: `square reported ${facts.status}`,
      });
      return {
        ...base,
        action: "failed",
        detail: `Square reports ${facts.status} — check whether the voucher legs were released.`,
      };
    }

    // Gift-card destination: the CARD BALANCE is the truth, not the status. A
    // live smoke showed a credit landed while the refund still read PENDING.
    if (row.destination === "gift_card" && row.destinationGiftCardId) {
      const balance = await deps
        .giftCardBalanceCents(row.destinationGiftCardId)
        .catch(() => null);
      if (balance !== null && balance >= row.refundedCents && row.refundedCents > 0) {
        await updateDealRefund(row.id, {
          state: "settled",
          squareRefundStatus: facts?.status ?? "COMPLETED",
          settledAt: true,
          lastError: null,
        });
        await recomputeDealRefundTotals(row.purchaseId);
        return { ...base, action: "settled", detail: `Credit confirmed on the card (${balance}¢).` };
      }
      if (stale) {
        return {
          ...base,
          action: "needs_human",
          detail: `Gift card ${row.destinationGiftCardId} still shows ${balance ?? "unreadable"}¢ after ${Math.round(ageMinutes)} min. Do NOT re-refund — check Square.`,
        };
      }
      return { ...base, action: "still_pending", detail: "Waiting on Square's batch credit." };
    }

    // Card destination with a refund id and a completed status: the money moved,
    // and only our bookkeeping is behind.
    if (facts && facts.status === "COMPLETED") {
      await updateDealRefund(row.id, {
        state: "settled",
        squareRefundStatus: facts.status,
        refundedCents: facts.amountCents,
        settledAt: true,
        lastError: null,
      });
      await recomputeDealRefundTotals(row.purchaseId);
      return { ...base, action: "settled", detail: "Square reports COMPLETED." };
    }

    if (stale) {
      return {
        ...base,
        action: "needs_human",
        detail: `Refund ${row.squareRefundId} is ${facts?.status ?? "unreadable"} after ${Math.round(ageMinutes)} min.`,
      };
    }
    return { ...base, action: "still_pending", detail: `Square reports ${facts?.status ?? "unknown"}.` };
  }

  // No refund id: the attempt died before Square was asked, or before we
  // recorded the answer. This is the one case a sweep MUST NOT guess at — a
  // blind replay here is exactly how you refund twice. A human re-plans instead;
  // the ledger row keeps the purchase locked until they do, and the 48-hour
  // window in `getOpenDealRefund` stops it wedging forever.
  if (stale) {
    await updateDealRefund(row.id, {
      state: "failed",
      lastError: `abandoned in ${row.state} with no Square refund id after ${Math.round(ageMinutes)} min`,
    });
    return {
      ...base,
      action: "failed",
      detail: `Abandoned in "${row.state}" with no refund id. Released for a re-plan — verify in Square that nothing moved.`,
    };
  }
  return { ...base, action: "still_pending", detail: `In "${row.state}", no Square id yet.` };
}
