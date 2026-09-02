/**
 * Recover-forward driver for the reconcile cron.
 *
 * A charged-but-unloaded card is credited here by replaying the load through
 * the Intercard router (onsite proxy first, cloud SOAP fallback) using the
 * row's stable `tpi_transaction_id`. The SOAP path dedups on that id, so a
 * replay never double-loads on it. After MAX_ATTEMPTS the row flips to
 * `load_failed` and logs for manual intervention.
 *
 * This used to run four phases feeding an on-prem EIS bridge queue (sweep
 * queued→fallback, sweep claimed→verify, verify against cloud history, then
 * replay). That bridge is retired — loads are synchronous through the router
 * now, so nothing new ever enters the queue. All that remains is this replay,
 * plus a loud alarm for any pre-cutover row still stuck in an ambiguous EIS
 * state so it can never strand a guest's money unseen.
 *
 * No cross-run lock needed: every credit is a dedup-safe replay and every state
 * flip is a single guarded UPDATE (one winner), so overlapping runs only
 * duplicate idempotent work.
 */
import { applyCreditPlan, creditPlanForRow, planIsEmpty } from "./credit-plan";
import { getLiveClaimForTxn } from "../data/voucher-claims-db";
import {
  listPendingLoads,
  markLoadState,
  incrementAttempt,
  countStuckLegacyQueueRows,
} from "../data/transactions-log";

const MAX_ATTEMPTS = 6;

export interface ReconcileSummary {
  scanned: number;
  loaded: number;
  stillPending: number;
  failed: number;
  /** Pre-cutover rows stuck in a legacy EIS 'claimed'/'verify' state (expected
   *  0). Non-zero → a human must settle them against Intercard reports. */
  stuckLegacy: number;
}

export async function reconcilePendingLoads(dryRun = false): Promise<ReconcileSummary> {
  const summary: ReconcileSummary = {
    scanned: 0,
    loaded: 0,
    stillPending: 0,
    failed: 0,
    stuckLegacy: 0,
  };

  // Alarm (not an auto-fix): a charged card stuck in a legacy EIS ambiguous
  // state can't be credited here without risking a double-charge, so surface it
  // every run until a human clears it. Expected to be 0 — cloud mode has been
  // forced since 2026-07-22, so the old queue drained long ago.
  summary.stuckLegacy = await countStuckLegacyQueueRows();
  if (summary.stuckLegacy > 0) {
    console.error(
      `[game-cards-reconcile] MANUAL INTERVENTION REQUIRED: ${summary.stuckLegacy} charged card(s) ` +
        `stuck in a legacy EIS 'claimed'/'verify' state — settle them against Intercard reports ` +
        `(these are NOT auto-credited; the EIS credit outcome is unknown and re-crediting would double-charge)`,
    );
  }

  // Replay every SOAP-eligible pending row (see listPendingLoads for exactly
  // which queue states are eligible and why).
  const rows = await listPendingLoads(100);
  summary.scanned = rows.length;

  for (const row of rows) {
    const plan = creditPlanForRow(row);
    const tokens = plan?.tokens ?? 0;
    const bonusTokens = plan?.bonusTokens ?? 0;

    if (dryRun) {
      summary.stillPending++;
      continue;
    }

    // Nothing resolvable to credit (retired/hand-edited package id) — never
    // guess, and never mark it loaded. Flag it for staff instead.
    if (!plan || planIsEmpty(plan)) {
      await markLoadState(row.txnId, "load_failed", `unresolvable package ${row.packageId}`);
      summary.failed++;
      console.error(
        `[game-cards-reconcile] MANUAL INTERVENTION REQUIRED txn=${row.txnId} ` +
          `card=${row.accountNumber}: package ${row.packageId} resolves to no credit`,
      );
      continue;
    }

    // A comped row is authorised by its voucher claim, not by a payment. The
    // live path checks this too, but the cron credits WITHOUT a client, so it
    // must make the same check independently — otherwise an orphan row (claim
    // raced, or the code already released back) would be credited here even
    // though loadCard refused it.
    if (row.kind === "voucher" || row.kind === "voucher_reload") {
      const claim = await getLiveClaimForTxn(row.txnId);
      if (!claim || claim.packageId !== row.packageId) {
        await markLoadState(row.txnId, "load_failed", "no live voucher claim");
        summary.failed++;
        console.error(
          `[game-cards-reconcile] voucher row NOT credited (no live claim) txn=${row.txnId} ` +
            `code=${row.voucherCode ?? "?"} card=${row.accountNumber}`,
        );
        continue;
      }
    }

    const attempt = await incrementAttempt(row.txnId);
    try {
      const { code, transport } = await applyCreditPlan(plan, {
        locationCode: row.locationCode,
        accountNumber: row.accountNumber,
        tpiTransactionID: row.tpiTransactionId,
      });
      if (code === 0) {
        await markLoadState(row.txnId, "loaded", undefined, transport);
        summary.loaded++;
        continue;
      }
      throw new Error(`Intercard returned code ${code}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "load retry failed";
      if (attempt >= MAX_ATTEMPTS) {
        await markLoadState(row.txnId, "load_failed", msg);
        summary.failed++;
        console.error(
          `[game-cards-reconcile] MANUAL INTERVENTION REQUIRED txn=${row.txnId} ` +
            `card=${row.accountNumber} tokens=${tokens}+${bonusTokens} after ${attempt} attempts: ${msg}`,
        );
      } else {
        summary.stillPending++;
        console.warn(
          `[game-cards-reconcile] retry ${attempt}/${MAX_ATTEMPTS} still pending txn=${row.txnId}: ${msg}`,
        );
      }
    }
  }

  return summary;
}
