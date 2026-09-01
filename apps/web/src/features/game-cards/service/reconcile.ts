/**
 * Recover-forward driver for the reconcile cron, in four ordered phases:
 *
 *  1. Sweep stale 'queued' rows (>60s, no bridge claimed) → 'soap_fallback',
 *     so they join THIS run's SOAP replay set.
 *  2. Sweep stale 'claimed' rows (lease expired, bridge died mid-flight) →
 *     'verify'. The EIS credit may or may not have landed — never retried.
 *  3. Resolve 'verify' rows: look for the credit in cloud account history
 *     (match tokens+bonus at/after queue time). Found → loaded. Not found
 *     after VERIFY_MANUAL_AFTER_MIN → 'manual' + load_failed (staff checks
 *     Intercard reports; the fail direction is over-alert, never a double
 *     credit — the EIS credit has NO idempotency id).
 *  4. Replay the cloud SOAP load for every SOAP-eligible pending row using
 *     the stored, stable `tpi_transaction_id` — Intercard dedups on it, so a
 *     replay never double-loads. After MAX_ATTEMPTS the row flips to
 *     `load_failed` and logs for manual intervention.
 *
 * No cross-run lock needed: every credit this cron can issue is a dedup-safe
 * SOAP replay, and every state flip is a single guarded UPDATE (one winner) —
 * two overlapping runs can only duplicate idempotent work.
 */
// Reads go through the router (onsite first, cloud SOAP fallback). The
// timestamp parser is pure and transport-agnostic, so it stays where it lives.
import { verifyAccount } from "../data/intercard-router";
import { parseIntercardTimestamp } from "../data/intercard";
import { applyCreditPlan, creditPlanForRow, planIsEmpty } from "./credit-plan";
import { getLiveClaimForTxn } from "../data/voucher-claims-db";
import {
  listPendingLoads,
  markLoadState,
  incrementAttempt,
  sweepStaleQueued,
  sweepStaleClaimed,
  listVerifyRows,
  markVerifiedLoaded,
  markVerifyManual,
  type TxnRow,
} from "../data/transactions-log";

const MAX_ATTEMPTS = 6;
/**
 * How long an unknown-outcome (verify) row may wait for its EIS credit to
 * appear in cloud history before it's flagged manual. Sized by the measured
 * EIS→cloud sync lag at pilot — raise if the lag is worse.
 */
const VERIFY_MANUAL_AFTER_MIN = 30;
/** Clock skew allowed when matching a history line to a queued job. */
const VERIFY_SKEW_MIN = 10;

export interface ReconcileSummary {
  scanned: number;
  loaded: number;
  stillPending: number;
  failed: number;
  sweptToFallback: number;
  sweptToVerify: number;
  verifyScanned: number;
  verified: number;
  manual: number;
}

/** Epoch ms from a Neon timestamp (TIMESTAMPTZ arrives as Date at runtime). */
function epochMs(v: unknown): number | null {
  if (v == null) return null;
  const t = v instanceof Date ? v.getTime() : Date.parse(String(v));
  return Number.isFinite(t) ? t : null;
}

export async function reconcilePendingLoads(dryRun = false): Promise<ReconcileSummary> {
  const summary: ReconcileSummary = {
    scanned: 0,
    loaded: 0,
    stillPending: 0,
    failed: 0,
    sweptToFallback: 0,
    sweptToVerify: 0,
    verifyScanned: 0,
    verified: 0,
    manual: 0,
  };

  // ── 1+2. Queue sweeps (before the replay list so swept rows join this run) ─
  if (!dryRun) {
    summary.sweptToFallback = (await sweepStaleQueued()).length;
    summary.sweptToVerify = (await sweepStaleClaimed()).length;
  }

  // ── 3. Resolve unknown-outcome rows from cloud history ────────────────────
  const verifyRows = await listVerifyRows(50);
  summary.verifyScanned = verifyRows.length;
  if (!dryRun) {
    for (const row of verifyRows) await resolveVerifyRow(row, summary);
  }

  // ── 4. SOAP replay (NULL / 'soap_fallback' rows only — see listPendingLoads)
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
      const { code } = await applyCreditPlan(plan, {
        locationCode: row.locationCode,
        accountNumber: row.accountNumber,
        tpiTransactionID: row.tpiTransactionId,
      });
      if (code === 0) {
        await markLoadState(row.txnId, "loaded", undefined, "soap");
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

/**
 * One verify row: did the bridge's EIS credit actually land? Cloud history is
 * the only cross-check we have, and it lags the center — so a young row that
 * doesn't match yet is simply left for the next run.
 */
async function resolveVerifyRow(row: TxnRow, summary: ReconcileSummary): Promise<void> {
  const anchorMs = epochMs(row.queuedAt) ?? epochMs(row.claimedAt) ?? epochMs(row.createdAt) ?? 0;

  let matched = false;
  try {
    const v = await verifyAccount(row.accountNumber, row.locationCode);
    const cutoff = anchorMs - VERIFY_SKEW_MIN * 60_000;
    matched = !!v.transactions?.some((t) => {
      if (t.tokens !== row.tokens || t.bonusTokens !== row.bonusTokens) return false;
      const ts = parseIntercardTimestamp(t.timeStamp);
      return ts !== null && ts >= cutoff;
    });
  } catch (err) {
    // History unreachable — leave the row for the next run.
    console.warn(
      `[game-cards-reconcile] verify lookup failed txn=${row.txnId}: ` +
        (err instanceof Error ? err.message : err),
    );
    return;
  }

  if (matched) {
    if (await markVerifiedLoaded(row.txnId)) summary.verified++;
    return;
  }

  if (Date.now() - anchorMs >= VERIFY_MANUAL_AFTER_MIN * 60_000) {
    const msg =
      `EIS outcome unknown and no matching credit in cloud history after ` +
      `${VERIFY_MANUAL_AFTER_MIN} min — check Intercard reports before hand-crediting`;
    if (await markVerifyManual(row.txnId, msg)) {
      summary.manual++;
      console.error(
        `[game-cards-reconcile] MANUAL INTERVENTION REQUIRED (verify) txn=${row.txnId} ` +
          `card=${row.accountNumber} tokens=${row.tokens}+${row.bonusTokens} ` +
          `eis_code=${row.eisCode ?? "-"} ${row.eisDescription ?? ""}`,
      );
    }
  }
}
