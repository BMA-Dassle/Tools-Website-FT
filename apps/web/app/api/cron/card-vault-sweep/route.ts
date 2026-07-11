import { NextRequest, NextResponse } from "next/server";
import { verifyCron } from "@/lib/cron-auth";
import { getBowlingReservation, listCancelGroupReservations } from "@/lib/bowling-db";
import { reserveBaseKey } from "~/features/booking/service/reserve-idempotency";
import { disableCard } from "~/features/account/data/cards";
import { recordAdminAction } from "~/features/reservations-admin/audit";
import {
  captureCardFromDeposit,
  countLiveReservationsForCustomer,
  isDueForDisable,
  listDueForDisable,
  listPendingCaptures,
  markDisabled,
  recordCaptureFailure,
  recordDisableFailure,
  type SavedCardRow,
} from "~/features/card-vault";

/**
 * Card-vault sweep — hourly ("15 * * * *"), two phases:
 *
 *   1. CAPTURE RETRY — `reservation_saved_cards` rows whose CreateCard never
 *      succeeded (square_card_id NULL, attempts < 5). Re-runs the capture
 *      from the stored source_payment_id; the fingerprint/brand dedupe
 *      inside captureCardFromDeposit makes a retry safe even if the original
 *      CreateCard actually landed but the row write failed.
 *
 *   2. DISABLE DUE CARDS — silently captured cards (we_added, no permanent
 *      consent) whose ENTIRE source money group has been terminal
 *      (completed | cancelled | no_show) for > 72h, when the customer has no
 *      other live reservation. SQL shortlists candidates; the pure
 *      `isDueForDisable` predicate makes the final call from live rows.
 *      Every disable is audited via recordAdminAction("card_vault_disable").
 *
 *   GET /api/cron/card-vault-sweep
 *       &dryRun=1  — scan + report, no Square calls / writes
 *       &limit=N   — cap rows per phase this run (default 25)
 *
 * See tasks/future/reservation-editing-plan.md §7 "Deletion".
 */

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const DEFAULT_LIMIT = 25;

interface DisableEvaluation {
  due: boolean;
  reason?: string;
  legIds: number[];
}

/** Load the row's money group + customer live count and run the predicate. */
async function evaluateDisable(row: SavedCardRow, now: Date): Promise<DisableEvaluation> {
  if (row.sourceReservationId == null) {
    // No reservation anchor (pathological capture) — we can't prove the
    // group is terminal, so we never disable. Left for manual review.
    return { due: false, reason: "no_source_reservation", legIds: [] };
  }
  const anchor = await getBowlingReservation(row.sourceReservationId);
  if (!anchor) {
    return { due: false, reason: "reservation_not_found", legIds: [] };
  }
  const group = await listCancelGroupReservations(anchor);
  const legIds = group.map((g) => g.id);
  const liveCount = await countLiveReservationsForCustomer(row.squareCustomerId, legIds);
  const due = isDueForDisable(row, group, liveCount, now);
  return { due, reason: due ? undefined : "not_due", legIds };
}

export async function GET(req: NextRequest) {
  const denied = verifyCron(req);
  if (denied) return denied;

  const started = Date.now();
  const url = new URL(req.url);
  const dryRun = url.searchParams.get("dryRun") === "1";
  const limit = Math.max(
    1,
    Math.min(
      200,
      parseInt(url.searchParams.get("limit") || String(DEFAULT_LIMIT), 10) || DEFAULT_LIMIT,
    ),
  );
  const now = new Date();

  // ── Phase 1: retry pending captures ────────────────────────────────────
  const pending = await listPendingCaptures(limit);
  let capturesAttempted = 0;
  let capturesSucceeded = 0;
  let capturesSkipped = 0;
  let capturesFailed = 0;

  for (const row of pending) {
    if (dryRun) continue;
    capturesAttempted++;
    try {
      // Deterministic per payment id, so every sweep retry of this row
      // replays the SAME CreateCard key (`cof-` + 16 hex = 20 chars ≤ 45).
      const result = await captureCardFromDeposit({
        squareCustomerId: row.squareCustomerId,
        paymentId: row.sourcePaymentId,
        reservationId: row.sourceReservationId,
        depositOrderId: row.sourceDepositOrderId,
        baseKey: reserveBaseKey(row.sourcePaymentId),
        // we_added=false pending rows came from the "saved card" checkout path.
        sourceKind: row.weAdded ? "card" : "saved",
        permanentConsent: row.permanentConsent,
      });
      if (!result.ok) capturesFailed++;
      else if ("skipped" in result && result.skipped) capturesSkipped++;
      else capturesSucceeded++;
    } catch (err) {
      // captureCardFromDeposit never throws by contract; belt-and-braces.
      capturesFailed++;
      await recordCaptureFailure({
        squareCustomerId: row.squareCustomerId,
        sourceReservationId: row.sourceReservationId,
        sourceDepositOrderId: row.sourceDepositOrderId,
        sourcePaymentId: row.sourcePaymentId,
        permanentConsent: row.permanentConsent,
        consentSource: row.consentSource,
        error: err instanceof Error ? err.message : "sweep capture retry threw",
      }).catch(() => {});
    }
  }

  // ── Phase 2: disable due cards ─────────────────────────────────────────
  const candidates = await listDueForDisable(limit);
  let evaluated = 0;
  let due = 0;
  let disabled = 0;
  let alreadyDisabled = 0;
  let deferred = 0;
  let disableFailed = 0;
  const wouldDisable: Array<{ id: number; cardId: string; reservationId: number | null }> = [];

  for (const row of candidates) {
    evaluated++;
    let evaluation: DisableEvaluation;
    try {
      evaluation = await evaluateDisable(row, now);
    } catch (err) {
      console.error(`[card-vault-sweep] evaluate failed row=${row.id}:`, err);
      deferred++;
      continue;
    }
    if (!evaluation.due) {
      deferred++;
      continue;
    }
    due++;
    if (dryRun) {
      wouldDisable.push({
        id: row.id,
        cardId: row.squareCardId!,
        reservationId: row.sourceReservationId,
      });
      continue;
    }

    const result = await disableCard(row.squareCardId!);
    const auditDetail = {
      savedCardRowId: row.id,
      squareCardId: row.squareCardId,
      brand: row.cardBrand,
      last4: row.cardLast4,
      alreadyDisabled: result.alreadyDisabled ?? false,
      groupLegIds: evaluation.legIds,
    };
    if (result.ok) {
      disabled++;
      if (result.alreadyDisabled) alreadyDisabled++;
      await markDisabled(row.id);
      await recordAdminAction({
        reservationId: row.sourceReservationId ?? 0,
        action: "card_vault_disable",
        outcome: "success",
        detail: auditDetail,
        actor: "card-vault-sweep",
      });
    } else {
      disableFailed++;
      await recordDisableFailure(row.id, result.error ?? "disable failed");
      await recordAdminAction({
        reservationId: row.sourceReservationId ?? 0,
        action: "card_vault_disable",
        outcome: "failed",
        detail: auditDetail,
        error: result.error,
        actor: "card-vault-sweep",
      });
    }
  }

  const elapsedMs = Date.now() - started;
  console.log(
    `[card-vault-sweep] dryRun=${dryRun} pending=${pending.length} captured=${capturesSucceeded} ` +
      `captureFailed=${capturesFailed} candidates=${candidates.length} due=${due} ` +
      `disabled=${disabled} (already=${alreadyDisabled}) deferred=${deferred} ` +
      `disableFailed=${disableFailed} elapsed=${elapsedMs}ms`,
  );

  return NextResponse.json({
    ok: true,
    dryRun,
    captures: {
      pending: pending.length,
      attempted: capturesAttempted,
      succeeded: capturesSucceeded,
      skipped: capturesSkipped,
      failed: capturesFailed,
    },
    disables: {
      candidates: candidates.length,
      evaluated,
      due,
      disabled,
      alreadyDisabled,
      deferred,
      failed: disableFailed,
      ...(dryRun ? { wouldDisable } : {}),
    },
    elapsedMs,
  });
}
