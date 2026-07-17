/**
 * cancelReservationCascade — executes a CancelPlan.
 *
 * Execution order and its reasoning:
 *   A. audit row (fatal)          — no money moves without its record.
 *   B. MONEY (fatal)              — per-tender refunds (exactly-once via
 *                                   refunded_money) OR store-credit issuance
 *                                   (GAN persisted before activation).
 *   C. COMMIT — mark every active leg cancelled in Neon AND mark the Redis
 *      booking record cancelled. Sitting between money and teardown:
 *      (1) the settle crons all filter status='confirmed', so the window where
 *      one could charge the just-drained gift card closes immediately after
 *      the money step; (2) bmi-cancel-sweep treats a -4 as intentional only
 *      via its record gates (Pandora state writes leave userUpdatedId=-1,
 *      identical to BMI's auto-cancel bug), so BOTH gates — Redis booking
 *      record and Neon status — must be cancelled BEFORE the -4 lands in
 *      teardown, or the sweep recovers the project within 5 minutes (res
 *      11417 / W48833, 2026-07-07); (3) a crash after B re-runs safely (the
 *      money step no-ops on re-entry), a crash after C resumes teardown via
 *      resumeTeardown.
 *   D. Best-effort teardown       — day-of order cancels, gift-card
 *                                   drain/deactivate, QAMF delete, BMI -4,
 *                                   add-on cancels, loyalty/promo cleanup.
 *                                   Failures become loud warnings, never a
 *                                   stuck half-cancel.
 *   E. audit completion + email/SMS (post-commit; failures reported to the UI
 *      as chips, never fail the cancel — the GAN is already on the row).
 *
 * NOTE ON AMOUNTS: refund/store-credit amounts are GROUP-level (one deposit
 * funds the whole group) but are stamped on every cancelled leg for display.
 * Never SUM refund_cents/store_credit_cents across legs of one deposit group —
 * reservation_cancel_events is the authoritative money record.
 */
import {
  updateBowlingReservationCancelled,
  updateStoreCreditIssued,
  type BowlingReservation,
} from "@/lib/bowling-db";
import { deleteReservation as deleteQamfReservation } from "@/lib/qamf-bowling";
import { cancelBmiAttractions } from "@/lib/bmi-attraction-cancel";
import { finishCancelEvent, startCancelEvent } from "@/lib/reservation-cancel-log";
import { refundRedemption } from "~/features/discount-codes/data";
import { cancelBmiProject } from "./bmi-cancel";
import { markBookingRecordCancelled } from "./booking-record";
import { resolveCenter } from "./centers";
import { legLabel } from "./guards";
import { buildCancelPlan } from "./plan";
import {
  cancelDayofOrder,
  deactivateGiftCard,
  deleteLoyaltyReward,
  drainGiftCard,
  refundTender,
} from "./square-actions";
import { issueStoreCredit } from "./store-credit";
import { sendCancellationNotifications } from "./notify";
import { CancelGuardError, type CancelPlan, type CancelRequest, type CancelResult } from "./types";

function legSummaries(legs: BowlingReservation[]) {
  return legs.map((l) => ({
    neonId: l.id,
    kind: l.productKind,
    label: legLabel(l),
    status: l.status,
  }));
}

function resultSteps(plan: CancelPlan) {
  return plan.steps.map((s) => ({
    kind: s.kind,
    detail: s.detail,
    fatal: s.fatal,
    amountCents: s.amountCents,
  }));
}

export async function cancelReservationCascade(req: CancelRequest): Promise<CancelResult> {
  const built = await buildCancelPlan(req);

  // Whole group already cancelled — idempotent success with the recorded outcome.
  if (built.kind === "already_cancelled") {
    const legs = built.legs;
    const money = legs.find((l) => l.refundCents > 0 || l.storeCreditGiftCardGan) ?? legs[0];
    return {
      ok: true,
      dryRun: req.dryRun,
      alreadyCancelled: true,
      outcome: money.cancellationOutcome ?? (money.refundCents > 0 ? "refund" : "none"),
      legs: legSummaries(legs),
      amountCents: money.storeCreditCents > 0 ? money.storeCreditCents : money.refundCents,
      steps: [],
      refundCents: money.refundCents || undefined,
      storeCredit: money.storeCreditGiftCardGan
        ? {
            giftCardId: money.storeCreditGiftCardId ?? "",
            gan: money.storeCreditGiftCardGan,
            amountCents: money.storeCreditCents,
          }
        : undefined,
      warnings: [],
    };
  }

  const { plan } = built;
  if (req.dryRun) {
    return {
      ok: true,
      dryRun: true,
      outcome: plan.outcome,
      legs: legSummaries(plan.legs),
      amountCents: plan.amountCents,
      steps: resultSteps(plan),
      warnings: plan.warnings,
    };
  }

  const warnings = [...plan.warnings];
  const stepLog: Array<{ kind: string; target: string; result: string }> = [];
  const log = (kind: string, target: string, result: string) => {
    stepLog.push({ kind, target, result });
    console.log(`[cancel/${plan.cascadeId}] ${kind} ${target}: ${result}`);
  };

  // ── A. Audit row — fatal ────────────────────────────────────────────────────
  await startCancelEvent({
    cascadeId: plan.cascadeId,
    anchorReservationId: plan.anchorId,
    legIds: plan.legIds,
    outcome: plan.outcome,
    actor: req.actor,
    attempt: plan.attempt,
    plan: plan.steps,
  });

  // ── B. Money — fatal ────────────────────────────────────────────────────────
  const refundIds: string[] = [];
  let refundedCents = 0;
  let storeCredit: CancelResult["storeCredit"];
  const moneyLeg =
    plan.legs.find((l) => l.squareGiftCardId) ??
    plan.legs.find((l) => l.squareDepositPaymentId) ??
    plan.legs[0];

  try {
    if (plan.outcome === "refund") {
      const tenderOrder = plan.facts.depositOrder?.tenders ?? [];
      for (const step of plan.steps.filter((s) => s.kind === "refund_tender")) {
        const tenderIndex = tenderOrder.findIndex((t) => t.paymentId === step.target);
        const r = await refundTender({
          cascadeId: plan.cascadeId,
          tenderIndex: tenderIndex >= 0 ? tenderIndex : 0,
          paymentId: step.target,
          reason: "Refund: Reservation Deposit",
        });
        if (r.refundId) refundIds.push(r.refundId);
        refundedCents += r.refundedCents;
        log(
          "refund_tender",
          step.target,
          r.refundId ? `refunded ${r.refundedCents}¢ (${r.refundId})` : "already refunded",
        );
      }
    } else if (plan.outcome === "store_credit") {
      const issued = await issueStoreCredit({
        cascadeId: plan.cascadeId,
        anchorNeonId: moneyLeg.id,
        internalGiftCardId: moneyLeg.squareGiftCardId ?? "",
        amountCents: plan.amountCents,
        locationId: plan.facts.giftCard?.locationId ?? "",
        squareCustomerId: moneyLeg.squareCustomerId,
        existing: plan.existingStoreCredit,
      });
      storeCredit = {
        giftCardId: issued.giftCardId,
        gan: issued.gan,
        amountCents: issued.amountCents,
      };
      log(
        "issue_store_credit",
        issued.giftCardId,
        `${issued.strategy} ${issued.amountCents}¢ gan=${issued.gan}`,
      );
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    await finishCancelEvent(plan.cascadeId, { state: "failed", stepLog, error: detail });
    console.error(`[cancel/${plan.cascadeId}] MONEY step failed — cascade aborted:`, detail);
    if (err instanceof CancelGuardError) throw err;
    throw new CancelGuardError(
      "amount_mismatch",
      `Money step failed — nothing was cancelled. ${detail}`,
      502,
    );
  }

  // ── C. Commit — mark every active leg cancelled ─────────────────────────────
  const activeLegs = plan.legs.filter((l) => l.status !== "cancelled");
  for (const leg of activeLegs) {
    await updateBowlingReservationCancelled(leg.id, {
      squareRefundId: refundIds[0],
      refundCents: plan.outcome === "refund" ? refundedCents : 0,
      cancellationOutcome: plan.outcome,
      cancelledBy: req.actor,
    });
    log("mark_cancelled", String(leg.id), "cancelled");
    // Mirror the store-credit card onto every leg so any row (either combo
    // leg) shows the GAN in the portal.
    if (storeCredit && leg.id !== moneyLeg.id) {
      await updateStoreCreditIssued(leg.id, {
        giftCardId: storeCredit.giftCardId,
        gan: storeCredit.gan,
        cents: storeCredit.amountCents,
        state: "issued",
      }).catch((err) =>
        console.warn(`[cancel/${plan.cascadeId}] store-credit mirror to #${leg.id} failed:`, err),
      );
    }
  }

  // Close the sweep's booking-record gate BEFORE the BMI -4 lands in teardown.
  // ALL legs (not just active) so a re-run heals a record a prior attempt
  // missed. Failures are warnings — the sweep's Neon gate is the backstop.
  const bmiBillIds = [
    ...new Set(plan.legs.map((l) => l.bmiBillId).filter((v): v is string => !!v)),
  ];
  for (const billId of bmiBillIds) {
    try {
      const r = await markBookingRecordCancelled({ bmiBillId: billId, cancelledBy: req.actor });
      log("mark_booking_record", billId, r);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      warnings.push(`booking-record mark (bill ${billId}): ${detail}`);
      log("mark_booking_record", billId, `FAILED: ${detail}`);
    }
  }

  // ── D. Best-effort teardown ─────────────────────────────────────────────────
  const legById = new Map(plan.legs.map((l) => [l.id, l]));
  for (const step of plan.steps) {
    try {
      switch (step.kind) {
        case "cancel_dayof_order": {
          const r = await cancelDayofOrder({ orderId: step.target });
          log(step.kind, step.target, r);
          break;
        }
        case "drain_internal_gc": {
          const drained = await drainGiftCard({
            cascadeId: plan.cascadeId,
            giftCardId: step.target,
          });
          log(step.kind, step.target, `drained ${drained}¢`);
          break;
        }
        case "deactivate_internal_gc": {
          await deactivateGiftCard({ cascadeId: plan.cascadeId, giftCardId: step.target });
          log(step.kind, step.target, "deactivated");
          break;
        }
        case "delete_qamf": {
          const leg = legById.get(step.legId ?? -1);
          if (!leg) break;
          const center = resolveCenter(leg.centerCode, leg.productKind);
          await deleteQamfReservation(center.qamfCenterId, step.target);
          log(step.kind, step.target, "deleted");
          break;
        }
        case "cancel_bmi_project": {
          const leg = legById.get(step.legId ?? -1);
          if (!leg) break;
          const center = resolveCenter(leg.centerCode, leg.productKind);
          const r = await cancelBmiProject({
            pandoraStateSlug: center.pandoraStateSlug,
            bmiClientKey: center.bmiClientKey,
            bmiBillId: step.target,
            bmiReservationNumber: leg.bmiReservationNumber,
          });
          if (!r.ok) {
            warnings.push(`BMI cancel (bill ${step.target}): ${r.detail ?? r.method}`);
          }
          log(step.kind, step.target, `${r.method}${r.ok ? "" : " FAILED"}`);
          break;
        }
        case "cancel_bmi_addons": {
          const leg = legById.get(step.legId ?? -1);
          if (!leg?.attractionBookings?.length) break;
          const center = resolveCenter(leg.centerCode, leg.productKind);
          await cancelBmiAttractions(center.attractionCancelCenterCode, leg.attractionBookings);
          log(step.kind, step.target, "requested");
          break;
        }
        case "delete_loyalty_reward": {
          await deleteLoyaltyReward(step.target);
          log(step.kind, step.target, "deleted (points returned)");
          break;
        }
        case "refund_promo_redemption": {
          const ok = await refundRedemption("bowling", step.target);
          log(step.kind, step.target, ok ? "released" : "no redemption found");
          break;
        }
        default:
          break; // money + mark handled above
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      warnings.push(`${step.kind} (${step.target}): ${detail}`);
      log(step.kind, step.target, `FAILED: ${detail}`);
    }
  }

  // ── E. Audit completion + notifications ────────────────────────────────────
  await finishCancelEvent(plan.cascadeId, {
    state: "completed",
    refundCents: refundedCents || undefined,
    refundIds: refundIds.length ? refundIds : undefined,
    storeCreditGiftCardId: storeCredit?.giftCardId,
    storeCreditGan: storeCredit?.gan,
    stepLog: { steps: stepLog, warnings },
  });

  // Staff can keep a store-credit card to themselves (notifyGuest=false) when
  // they're rebooking for the guest on the phone — the GAN is already on the
  // row and in the modal; nothing goes to the guest.
  const skipGuestNotice =
    plan.outcome === "store_credit" && req.actor === "admin" && req.notifyGuest === false;
  let notified: { email: boolean; sms: boolean } = { email: false, sms: false };
  if (skipGuestNotice) {
    log("notify", String(moneyLeg.id), "skipped by staff (gift card kept for staff rebook)");
  } else {
    try {
      notified = await sendCancellationNotifications({
        anchor: moneyLeg,
        legs: plan.legs,
        outcome: plan.outcome,
        amountCents:
          plan.outcome === "refund" ? refundedCents || plan.amountCents : plan.amountCents,
        storeCredit,
      });
    } catch (err) {
      warnings.push(`notifications failed: ${err instanceof Error ? err.message : String(err)}`);
      console.error(`[cancel/${plan.cascadeId}] notifications threw:`, err);
    }
  }

  return {
    ok: true,
    dryRun: false,
    outcome: plan.outcome,
    legs: legSummaries(plan.legs),
    amountCents: plan.amountCents,
    steps: resultSteps(plan),
    refundIds: refundIds.length ? refundIds : undefined,
    refundCents: plan.outcome === "refund" ? refundedCents : undefined,
    storeCredit,
    notified,
    notificationsSkipped: skipGuestNotice || undefined,
    warnings,
  };
}
