/**
 * Recover-forward driver for the reconcile cron. Replays the Intercard load for
 * every charged-but-unloaded row using the stored, stable `tpi_transaction_id`
 * — Intercard dedups on it, so a replay never double-loads. After MAX_ATTEMPTS
 * it flips the row to `load_failed` and logs for manual intervention.
 */
import { creditTokens } from "../data/intercard";
import { getPackage } from "../constants";
import { listPendingLoads, markLoadState, incrementAttempt } from "../data/transactions-log";

const MAX_ATTEMPTS = 6;

export interface ReconcileSummary {
  scanned: number;
  loaded: number;
  stillPending: number;
  failed: number;
}

export async function reconcilePendingLoads(dryRun = false): Promise<ReconcileSummary> {
  const rows = await listPendingLoads(100);
  const summary: ReconcileSummary = {
    scanned: rows.length,
    loaded: 0,
    stillPending: 0,
    failed: 0,
  };

  for (const row of rows) {
    const pkg = getPackage(row.packageId);
    const tokens = pkg?.tokens ?? row.tokens;
    const bonusTokens = pkg?.bonusTokens ?? row.bonusTokens;

    if (dryRun) {
      summary.stillPending++;
      continue;
    }

    const attempt = await incrementAttempt(row.txnId);
    try {
      const { code } = await creditTokens({
        locationCode: row.locationCode,
        accountNumber: row.accountNumber,
        tokens,
        bonusTokens,
        tpiTransactionID: row.tpiTransactionId,
      });
      if (code === 0) {
        await markLoadState(row.txnId, "loaded");
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
