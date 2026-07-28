/**
 * editReservationCascade / executeEditCascade — the reservation-edit executor.
 *
 * Mirrors the cancellation cascade's shape: audit row → fatal money steps →
 * Neon commit → best-effort external sync → audit finish. All Square keys
 * derive from `edit-{anchorId}-a{attempt}` (attempt bumps only on FAILED
 * attempts — crashed/pending attempts replay their keys).
 *
 * Rollout gates (all read at call time):
 *   RESERVATION_EDIT_V2               — master switch (route enforces too)
 *   RESERVATION_EDIT_V2_RACE          — BMI race-leg edits (add/remove heats)
 *   RESERVATION_EDIT_V2_MID_DECREASE  — mid-session refunds (assumption A1)
 *   RESERVATION_EDIT_V2_POST          — post-complete refund+rebuild
 */

import {
  getBowlingReservation,
  getReservationPlayersWithShoeAllowance,
  getBowlingExperiences,
  updateReservationAfterEdit,
  updateStoreCreditIssued,
  type BowlingReservation,
  type ReservationLine,
} from "@/lib/bowling-db";
import {
  finishEditEvent,
  getOpenEditEvent,
  markEditPendingPayment,
  nextEditAttempt,
  recordEditPayment,
  recordEditRefund,
  refundedCentsForPayment,
  startEditEvent,
  listEditEventsByAnchors,
} from "@/lib/reservation-edit-log";
import { getLatestCancelEvent } from "@/lib/reservation-cancel-log";
import { loadGiftCard, mintDigitalGiftCard, refundSquarePayment } from "@/lib/square-gift-card";
import redis from "@/lib/redis";
import { recordAdminAction } from "~/features/reservations-admin/audit";
import {
  fetchGiftCardFacts,
  fetchOrderFacts,
  fetchPaymentFacts,
  sq,
} from "~/features/cancellation/square-actions";
import { resolveCenter } from "~/features/cancellation/centers";

import type { EditPlan, EditPlanLeg, PlanLine } from "./plan";
import {
  adjustGiftCardDown,
  chargeDayofOrder,
  createEditTopupOrderAndCharge,
  fetchRefundFacts,
  refundTenderPartial,
  updateDayofOrderLines,
  waitForRefundCredit,
} from "./square-actions";
import { playersToQamfRoster, rebookQamfForLaneChange, syncQamfPlayers } from "./qamf-sync";
import {
  EditGuardError,
  type EditPaymentSource,
  type EditSettlement,
  type EditStep,
  type EditWarning,
} from "./types";

export interface ExecuteEditRequest {
  plan: EditPlan;
  settlement?: EditSettlement;
  paymentSource?: EditPaymentSource;
  notifyGuest: boolean;
  actor: string;
  /** Request origin — BMI sync + payment links need absolute URLs. */
  origin: string;
  /**
   * Resume a pending_payment attempt (self-hosted payment-link completion):
   * reuse THIS editId so every Square idempotency key replays the original
   * attempt's namespace, and skip the await_payment_link step (the payment
   * source is now real).
   */
  resumeEditId?: string;
  /**
   * Staff-entered reason for the DAY-OF Square refund (owner rule 2026-07-27).
   *
   * The day-of leg must NOT carry "Refund: Reservation Deposit" — that string
   * is the accounting portal's journal key and belongs to the deposit/cash-out
   * leg alone. One economic refund moves money twice (day-of GC-payment
   * reversal + deposit card refund); if both carried the magic string the
   * portal would journal the event twice. Required whenever the plan contains
   * a day-of refund step.
   */
  dayofRefundReason?: string;
}

export interface EditResult {
  editId: string;
  state: "completed" | "pending_payment";
  diffCents: number;
  paymentIds: string[];
  refundIds: string[];
  storeCreditGan?: string;
  newQamfReservationId?: string;
  /** Set on pending_payment results — the link staff send to the guest. */
  paymentLinkUrl?: string;
  stepLog: Array<{ step: string; ok: boolean; detail?: string }>;
  warnings: EditWarning[];
}

const flag = (name: string): boolean => process.env[name] === "true";

/**
 * Edit-lock TTL. Long enough to outlive an await-the-gift-card-credit wait
 * (Square posts refund credits asynchronously — observed 30-90s on 2026-07-27,
 * and the wait step polls well past that before parking). The old 180s could
 * expire mid-settlement, letting a second mutation in while the first was
 * still holding un-decremented gift-card value. Refresh with `extendEditLock`
 * around any long wait rather than raising this further.
 */
export const EDIT_LOCK_TTL_SECONDS = 600;

/**
 * Refresh the edit lock's TTL. Called around long waits so a slow Square
 * settlement can't drop the mutual exclusion. Best-effort: a Redis failure
 * leaves the deterministic idempotency keys as the money guard, same as the
 * acquire path.
 */
export const extendEditLock = async (anchorId: number): Promise<void> => {
  try {
    await redis.set(`edit:lock:${anchorId}`, "1", "EX", EDIT_LOCK_TTL_SECONDS);
  } catch {
    /* Redis down — idempotency keys still protect money */
  }
};

/** Sum of |amount| still to refund across a list, oldest-last allocation. */
interface RefundTarget {
  paymentId: string;
  label: string;
}

export const executeEditCascade = async (req: ExecuteEditRequest): Promise<EditResult> => {
  const { plan } = req;
  const anchorId = plan.anchorId;
  const stepLog: EditResult["stepLog"] = [];
  const warnings: EditWarning[] = [...plan.warnings];

  // ── Locks: one mutation at a time per reservation; cancel wins ties ──
  const lockKey = `edit:lock:${anchorId}`;
  let lockHeld = false;
  try {
    lockHeld = (await redis.set(lockKey, "1", "EX", EDIT_LOCK_TTL_SECONDS, "NX")) === "OK";
  } catch {
    lockHeld = true; // Redis down — deterministic idempotency keys still protect money
  }
  if (!lockHeld) throw new EditGuardError("edit_in_progress");

  try {
    const openCancel = await getLatestCancelEvent(anchorId);
    if (openCancel?.state === "started") {
      throw new EditGuardError("cancel_in_progress", "a cancellation is mid-flight for this group");
    }

    // ── Freshness re-check INSIDE the lock (lane-open cron race) ──────
    const anchor = await getBowlingReservation(anchorId);
    if (!anchor) throw new EditGuardError("not_found");
    for (const leg of plan.legs) {
      if (!leg.dayofOrderId) continue;
      const live = await fetchOrderFacts(leg.dayofOrderId);
      if (
        live.state !== (leg.orderState ?? live.state) ||
        live.tenderCount !== (leg.phase === "pre" ? 0 : live.tenderCount) ||
        live.totalCents !== leg.oldTotalCents
      ) {
        throw new EditGuardError(
          "plan_stale",
          `order ${leg.dayofOrderId} moved (state=${live.state} tenders=${live.tenderCount} total=${live.totalCents})`,
        );
      }
    }

    // ── Sub-flag gates for steps the plan may carry ────────────────────
    const kinds = new Set(plan.steps.map((s) => s.kind));
    if (
      (kinds.has("bmi_add_heats") ||
        kinds.has("bmi_remove_lines") ||
        kinds.has("bmi_attractions")) &&
      !flag("RESERVATION_EDIT_V2_RACE")
    ) {
      throw new EditGuardError(
        "bmi_line_unavailable",
        "BMI-touching edits are not enabled yet (RESERVATION_EDIT_V2_RACE)",
      );
    }
    // A1 ANSWERED NO (owner live finding 2026-07-11): Square refuses partial
    // refunds of gift-card-funded payments. Both paths below refund the
    // internal-GC day-of tender and need a redesign (refund the guest's card
    // directly + manual ADJUST_DECREMENT) before their flags may EVER turn on.
    if (kinds.has("refund_dayof_payment") && !flag("RESERVATION_EDIT_V2_MID_DECREASE")) {
      throw new EditGuardError(
        "mid_session_unsupported",
        "mid-session decreases need a redesign (Square can't partially refund gift-card tenders)",
      );
    }
    if (kinds.has("refund_dayof_order") && !flag("RESERVATION_EDIT_V2_POST")) {
      throw new EditGuardError(
        "post_complete_ack_required",
        "post-complete edits need a redesign (Square can't refund gift-card tenders)",
      );
    }

    // ── Audit row (fatal) ──────────────────────────────────────────────
    const attempt = req.resumeEditId
      ? parseInt(req.resumeEditId.match(/-a(\d+)$/)?.[1] ?? "1", 10)
      : await nextEditAttempt(anchorId);
    const editId = req.resumeEditId ?? `edit-${anchorId}-a${attempt}`;

    // ── Hard open-event guard ──────────────────────────────────────────
    // The plan-time hasOpenEditEvent check is only a WARNING, and the Redis
    // lock is per-process-window (and open-fails when Redis is down), so
    // neither stops a SECOND edit from starting on top of an attempt that
    // already moved money and parked. Resuming that same attempt is fine —
    // it replays the identical idempotency keys — but any OTHER editId would
    // plan against stale money facts and re-refund. Refuse it here, where we
    // finally know both ids.
    const openEvent = await getOpenEditEvent(plan.legIds);
    if (openEvent && openEvent.editId !== editId) {
      throw new EditGuardError(
        "edit_in_progress",
        `edit ${openEvent.editId} is ${openEvent.state} for this group — resume or fail it before starting another`,
      );
    }

    // Owner rule (2026-07-27): the day-of refund carries a staff-supplied
    // reason, never the deposit leg's journal key. Enforced before the audit
    // row so a missing reason can never reach a money step.
    const needsDayofReason = kinds.has("refund_dayof_payment") || kinds.has("refund_dayof_order");
    const dayofRefundReason = req.dayofRefundReason?.trim();
    if (needsDayofReason && !dayofRefundReason) {
      throw new EditGuardError(
        "dayof_reason_required",
        "a refund reason for the day-of charge is required (it is recorded on the Square refund and shown to accounting)",
      );
    }
    if (dayofRefundReason && /reservation deposit/i.test(dayofRefundReason)) {
      throw new EditGuardError(
        "dayof_reason_reserved",
        '"Reservation Deposit" is reserved for the deposit refund — the portal journals off it. Describe the day-of refund instead.',
      );
    }

    await startEditEvent({
      editId,
      anchorReservationId: anchorId,
      legIds: plan.legIds,
      phase: plan.phase,
      diffCents: plan.diffCents,
      settlement: plan.settlement,
      actor: req.actor,
      attempt,
      spec: plan.spec,
      plan: {
        planHash: plan.planHash,
        steps: plan.steps,
        legs: plan.legs.map((l) => ({
          id: l.reservationId,
          order: l.dayofOrderId,
          oldTotal: l.oldTotalCents,
          newTotal: l.newTotalCents,
        })),
      },
    });
    stepLog.push({ step: "audit_start", ok: true });

    const paymentIds: string[] = [];
    const refundIds: string[] = [];
    /**
     * Refunds of gift-card-funded payments whose credit has not yet been
     * confirmed on the card. Square posts these asynchronously, so the
     * decrement must not run until this drains (see wait_gc_credit).
     */
    const pendingGcCreditRefundIds: string[] = [];
    const rebuiltOrders: Array<{ oldOrderId: string; newOrderId: string }> = [];
    let storeCreditGan: string | undefined;
    let newQamfReservationId: string | undefined;

    // Resolve the payment source for increases once.
    const sourceId =
      req.paymentSource?.kind === "card_on_file"
        ? req.paymentSource.cardId
        : req.paymentSource?.kind === "nonce"
          ? req.paymentSource.token
          : req.paymentSource?.kind === "payment_link"
            ? null
            : (plan.chargeCard?.cardId ?? null);

    const center = resolveCenter(anchor.centerCode, anchor.productKind);
    const fallbackLocationId = center.attractionCancelCenterCode;
    const primaryLeg: EditPlanLeg = plan.legs[0];
    const chargeLocationId = primaryLeg.orderLocationId ?? fallbackLocationId;

    try {
      for (const step of plan.steps) {
        switch (step.kind) {
          case "audit_start":
            break; // already logged

          case "await_payment_link": {
            if (sourceId) {
              // Link completion: the payment source is real now — proceed.
              stepLog.push({ step: step.kind, ok: true, detail: "payment received" });
              break;
            }
            await markEditPendingPayment(editId);
            const { buildPayLinkUrl } = await import("./pay-link");
            const paymentLinkUrl = buildPayLinkUrl(req.origin, editId);
            stepLog.push({ step: step.kind, ok: true, detail: "awaiting guest payment" });
            await finishEditEvent(editId, { state: "pending_payment", stepLog });
            return {
              editId,
              state: "pending_payment",
              diffCents: plan.diffCents,
              paymentIds,
              refundIds,
              paymentLinkUrl,
              stepLog,
              warnings,
            };
          }

          case "qamf_rebook": {
            const rebook = await runQamfRebook(anchor, plan, primaryLeg);
            newQamfReservationId = rebook.newQamfId;
            stepLog.push({ step: step.kind, ok: true, detail: rebook.newQamfId });
            break;
          }

          case "bmi_add_heats":
          case "bmi_remove_lines": {
            // Gated above; the race sync module lands with the race rollout.
            const { syncBmiRaceEdit } = await import("./bmi-sync");
            const res = await syncBmiRaceEdit({
              editId,
              anchor,
              plan,
              mode: step.kind === "bmi_add_heats" ? "add" : "remove",
              origin: req.origin,
            });
            stepLog.push({ step: step.kind, ok: true, detail: res.detail });
            break;
          }

          case "bmi_attractions": {
            const { syncBmiAttractionEdit } = await import("./bmi-sync");
            const res = await syncBmiAttractionEdit({
              editId,
              anchor,
              plan,
              origin: req.origin,
            });
            stepLog.push({ step: step.kind, ok: true, detail: res.detail });
            break;
          }

          case "charge_topup": {
            if (!sourceId) throw new EditGuardError("payment_required", "no chargeable card");
            const topup = await createEditTopupOrderAndCharge({
              editId,
              locationId: chargeLocationId,
              amountCents: step.amountCents ?? plan.diffCents,
              note: `Reservation edit #${anchorId} — additional deposit`,
              sourceId,
              squareCustomerId: anchor.squareCustomerId,
            });
            await recordEditPayment(editId, topup.paymentId);
            paymentIds.push(topup.paymentId);
            stepLog.push({ step: step.kind, ok: true, detail: topup.paymentId });
            break;
          }

          case "charge_dayof_order": {
            if (!sourceId) throw new EditGuardError("payment_required", "no chargeable card");
            if (!primaryLeg.dayofOrderId || !primaryLeg.orderLocationId) {
              throw new Error("mid-session charge requires a day-of order");
            }
            const pay = await chargeDayofOrder({
              editId,
              orderId: primaryLeg.dayofOrderId,
              locationId: primaryLeg.orderLocationId,
              amountCents: step.amountCents ?? plan.diffCents,
              sourceId,
              squareCustomerId: anchor.squareCustomerId,
              note: `Reservation edit #${anchorId} — mid-session addition`,
            });
            await recordEditPayment(editId, pay.paymentId);
            paymentIds.push(pay.paymentId);
            stepLog.push({ step: step.kind, ok: true, detail: pay.paymentId });
            break;
          }

          case "load_gift_card": {
            if (!plan.giftCard) break;
            await loadGiftCard({
              giftCardId: plan.giftCard.id,
              locationId:
                (await fetchGiftCardFacts(plan.giftCard.id)).locationId ?? chargeLocationId,
              amountCents: step.amountCents ?? plan.diffCents,
              baseKey: editId,
              buyerPaymentInstrumentIds: paymentIds,
            });
            stepLog.push({ step: step.kind, ok: true, detail: `+${step.amountCents}` });
            break;
          }

          case "refund_tender": {
            const owed = step.amountCents ?? -plan.diffCents;
            // Capacity shortfalls throw INSIDE refundAcrossTenders before any
            // money moves; landing here under-refunded means a clamp race —
            // issued refunds are recorded, so a re-run nets them and heals.
            const r = await refundAcrossTenders(editId, anchor, plan, owed, refundIds);
            if (r.refundedCents < owed) {
              throw new Error(
                `refunded ${r.refundedCents} of ${owed} cents — issued refunds are recorded; re-run this edit to settle the remainder`,
              );
            }
            stepLog.push({ step: step.kind, ok: true, detail: `-${r.refundedCents}` });
            break;
          }

          case "refund_dayof_payment": {
            if (!anchor.dayofPaymentId) throw new Error("no lane-open payment id on the row");
            const asked = step.amountCents ?? -plan.diffCents;

            // NET refunds prior attempts already issued against THIS payment.
            // refundTenderPartial clamps only to the payment's un-refunded
            // remainder, which stays large after a partial — so a retry that
            // bumped to a fresh idempotency namespace would otherwise refund
            // the same items twice. (The deposit leg has had this netting
            // since 2026-07-11; the day-of leg never did.)
            const prior = await refundedCentsForPayment(
              plan.legIds,
              anchor.dayofPaymentId,
              fetchRefundFacts,
            );
            for (const rid of prior.refundIds) {
              if (!refundIds.includes(rid)) refundIds.push(rid);
              await recordEditRefund(editId, rid);
            }
            const owed = Math.max(0, asked - prior.cents);
            if (owed === 0) {
              stepLog.push({
                step: step.kind,
                ok: true,
                detail: `already refunded (${prior.cents}¢ netted)`,
              });
              break;
            }

            const r = await refundTenderPartial({
              editId,
              refundIndex: 90, // reserved namespace for the gift-card tender refund
              paymentId: anchor.dayofPaymentId,
              amountCents: owed,
              // Owner rule: staff-supplied, never the deposit journal key.
              reason: dayofRefundReason!,
            });
            if (r.refundId) {
              refundIds.push(r.refundId);
              await recordEditRefund(editId, r.refundId);
              // The gift-card credit posts ASYNCHRONOUSLY. Nothing downstream
              // may read the card's balance until it lands, or the decrement
              // no-ops and the refunded value survives on the card.
              pendingGcCreditRefundIds.push(r.refundId);
            }
            stepLog.push({ step: step.kind, ok: true, detail: r.refundId });
            break;
          }

          case "wait_gc_credit": {
            if (pendingGcCreditRefundIds.length === 0) {
              stepLog.push({ step: step.kind, ok: true, detail: "nothing pending" });
              break;
            }
            // A long poll can outlive the original lock TTL — keep holding it.
            await extendEditLock(anchorId);
            for (const rid of pendingGcCreditRefundIds) {
              const w = await waitForRefundCredit({
                refundId: rid,
                giftCardId: plan.giftCard?.id,
              });
              if (!w.settled) {
                // Park, do NOT decrement. The refunds are recorded, so a
                // resume of THIS editId replays the same idempotency keys and
                // picks up where we left off once Square settles.
                throw new Error(
                  `refund ${rid} has not credited the gift card yet (status ${w.status}) — ` +
                    `money already moved and is recorded; resume this edit to finish it`,
                );
              }
            }
            pendingGcCreditRefundIds.length = 0;
            stepLog.push({ step: step.kind, ok: true, detail: "credit settled" });
            break;
          }

          case "issue_store_credit": {
            const amount = step.amountCents ?? -plan.diffCents;
            storeCreditGan = await issueEditStoreCredit(editId, anchor, amount, chargeLocationId);
            stepLog.push({ step: step.kind, ok: true, detail: storeCreditGan });
            break;
          }

          case "adjust_gift_card_down": {
            const want = step.amountCents ?? -plan.diffCents;
            if (!plan.giftCard) {
              // The plan builder only WARNS when gift-card facts are
              // unreadable and drops this step. For a post-payment refund
              // that is a silent double-payout: the guest keeps the card
              // refund AND the value stays spendable on the internal card.
              throw new Error(
                `gift card facts unavailable but ${want}¢ must be decremented — ` +
                  `verify the card in Square before retrying`,
              );
            }
            if (pendingGcCreditRefundIds.length > 0) {
              throw new Error(
                `refusing to decrement before refund credit settles ` +
                  `(${pendingGcCreditRefundIds.join(", ")} still pending)`,
              );
            }
            const adjusted = await adjustGiftCardDown({
              editId,
              giftCardId: plan.giftCard.id,
              amountCents: want,
            });
            // A short/zero decrement means the credit is not on the card — a
            // green step here would leave refunded value spendable.
            if (adjusted < want) {
              throw new Error(
                `gift card ${plan.giftCard.id} decremented ${adjusted}¢ of ${want}¢ — ` +
                  `the refund credit has not landed; re-run this edit to finish it`,
              );
            }
            stepLog.push({ step: step.kind, ok: true, detail: `-${adjusted}` });
            break;
          }

          case "update_dayof_order": {
            const leg = plan.legs.find((l) => l.dayofOrderId === step.target);
            if (!leg || !leg.dayofOrderId) break;
            const res = await updateDayofOrderLines({
              editId,
              orderId: leg.dayofOrderId,
              desired: leg.newLines,
              expectedTotalCents: leg.newTotalCents,
            });
            stepLog.push({ step: step.kind, ok: true, detail: `total=${res.totalCents}` });
            break;
          }

          case "refund_dayof_order": {
            const leg = plan.legs.find((l) => l.dayofOrderId === step.target);
            if (!leg?.dayofOrderId) break;
            const facts = await fetchOrderFacts(leg.dayofOrderId);
            let n = 0;
            for (const tender of facts.tenders) {
              const r = await refundSquarePayment({
                paymentId: tender.paymentId,
                amountCents: tender.amountCents,
                baseKey: `${editId}-t${n}`,
                // Day-of leg: staff-supplied reason, never the deposit
                // journal key (owner rule 2026-07-27).
                reason: dayofRefundReason!,
              });
              refundIds.push(r.refundId);
              await recordEditRefund(editId, r.refundId);
              // Gift-card tenders credit back asynchronously — gate the
              // decrement (and the rebuild's repay) on wait_gc_credit.
              if (tender.paymentId === anchor.dayofPaymentId || facts.tenders.length === 1) {
                pendingGcCreditRefundIds.push(r.refundId);
              }
              n++;
            }
            stepLog.push({ step: step.kind, ok: true, detail: `${n} tender(s) refunded` });
            break;
          }

          case "rebuild_dayof_order":
          case "pay_dayof_order":
          case "complete_dayof_order": {
            // Handled as one unit on the first rebuild step; the others no-op.
            if (step.kind !== "rebuild_dayof_order") break;
            if (rebuiltOrders.length > 0) break; // already ran (multi-leg plans emit one trio per leg)
            const pairs = await rebuildAndSettleDayofOrders(editId, anchor, plan);
            rebuiltOrders.push(...pairs);
            stepLog.push({
              step: step.kind,
              ok: true,
              detail: pairs.map((p) => `${p.oldOrderId}→${p.newOrderId}`).join(","),
            });
            break;
          }

          case "neon_commit": {
            await commitNeon(plan, req, newQamfReservationId, rebuiltOrders);
            stepLog.push({ step: step.kind, ok: true });
            break;
          }

          case "qamf_set_players": {
            try {
              // step.target carries the money group's QAMF id (a combo's
              // bowling leg when the modal was opened from the race leg).
              const target = newQamfReservationId ?? step.target ?? anchor.qamfReservationId;
              if (!target) break;
              const { players } = await getReservationPlayersWithShoeAllowance(anchorId);
              const roster = playersToQamfRoster(
                (req.plan.spec.players ?? players).map((p) => ({
                  name: p.name ?? null,
                  shoeSize: p.shoeSize ?? null,
                  bumpers: p.bumpers ?? null,
                })),
                primaryLeg.newPlayerCount ?? players.length,
              );
              const synced = await syncQamfPlayers({
                qamfCenterId: center.qamfCenterId,
                qamfReservationId: target,
                players: roster,
                guestName: anchor.guestName ?? "Guest",
              });
              stepLog.push({ step: step.kind, ok: true, detail: `${synced.lanesUpdated} lane(s)` });
            } catch (e) {
              // Best-effort: staff can fix the roster in Conqueror.
              const msg = e instanceof Error ? e.message : String(e);
              warnings.push({
                severity: "warning",
                code: "qamf_players_failed",
                message: `QAMF roster sync failed — update Conqueror manually (${msg})`,
              });
              stepLog.push({ step: step.kind, ok: false, detail: msg });
            }
            break;
          }

          case "qamf_memo":
            // Title/Notes were re-patched inside syncQamfPlayers.
            stepLog.push({ step: step.kind, ok: true, detail: "with qamf_set_players" });
            break;

          case "notify": {
            if (step.detail === "teams_manager_alert") {
              // Post-complete: page the managers — QAMF/BMI need manual sync.
              const { sendPostCompleteEditAlert } = await import("./notify");
              const sent = await sendPostCompleteEditAlert({
                reservationId: anchorId,
                guestName: anchor.guestName ?? "Guest",
                centerCode: anchor.centerCode,
                diffCents: plan.diffCents,
                settlement: plan.settlement,
                editId,
                oldOrderIds: rebuiltOrders.map((p) => p.oldOrderId),
                newOrderIds: rebuiltOrders.map((p) => p.newOrderId),
              });
              stepLog.push({ step: step.kind, ok: sent, detail: "teams_manager_alert" });
              break;
            }
            await recordAdminAction({
              reservationId: anchorId,
              action: "edit",
              outcome: "success",
              detail: {
                editId,
                phase: plan.phase,
                diffCents: plan.diffCents,
                settlement: plan.settlement,
                spec: plan.spec,
                rebuiltOrders: rebuiltOrders.length > 0 ? rebuiltOrders : undefined,
              },
            });
            if (req.notifyGuest) {
              // Bowling/KBF: resend the confirmation with the updated details
              // (same delegation as the admin Resend action — forceResend
              // bypasses dedup). Best-effort; race/attraction confirmations
              // have no equivalent route yet → staff resend manually.
              if (anchor.productKind === "open" || anchor.productKind === "kbf") {
                try {
                  const res = await fetch(`${req.origin}/api/notifications/bowling-confirmation`, {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({
                      neonId: anchorId,
                      smsOptIn: true,
                      channel: "both",
                      forceResend: true,
                    }),
                  });
                  if (!res.ok) throw new Error(`HTTP ${res.status}`);
                  stepLog.push({ step: "notify_guest", ok: true, detail: "confirmation resent" });
                } catch (e) {
                  warnings.push({
                    severity: "info",
                    code: "resend_manual",
                    message: `Auto-resend failed (${e instanceof Error ? e.message : "error"}) — use the Resend action`,
                  });
                  stepLog.push({ step: "notify_guest", ok: false });
                }
              } else {
                warnings.push({
                  severity: "info",
                  code: "resend_manual",
                  message: "Resend the updated confirmation from the Resend action",
                });
              }
            }
            stepLog.push({ step: step.kind, ok: true });
            break;
          }
        }
      }

      await finishEditEvent(editId, {
        state: "completed",
        paymentIds,
        refundIds,
        storeCreditGan,
        stepLog,
      });
      return {
        editId,
        state: "completed",
        diffCents: plan.diffCents,
        paymentIds,
        refundIds,
        storeCreditGan,
        newQamfReservationId,
        stepLog,
        warnings,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      stepLog.push({ step: "error", ok: false, detail: msg });
      await finishEditEvent(editId, {
        state: "failed",
        paymentIds,
        refundIds,
        stepLog,
        error: msg,
      });
      await recordAdminAction({
        reservationId: anchorId,
        action: "edit",
        outcome: "failed",
        detail: { editId, phase: plan.phase, diffCents: plan.diffCents },
        error: msg,
      });
      throw err;
    }
  } finally {
    try {
      await redis.del(lockKey);
    } catch {
      /* lock expires on its own */
    }
  }
};

/* ── Step implementations ─────────────────────────────────────────────── */

const runQamfRebook = async (
  anchor: BowlingReservation,
  plan: EditPlan,
  primaryLeg: EditPlanLeg,
): Promise<{ newQamfId: string }> => {
  if (!anchor.qamfReservationId) throw new Error("no QAMF reservation to rebook");
  const center = resolveCenter(anchor.centerCode, anchor.productKind);
  // Resolve the web offer from the booked experience (stamp slug preferred).
  const stamp = (anchor.bookingMetadata as { bowling?: { experienceSlug?: string | null } })
    ?.bowling;
  const experiences = await getBowlingExperiences(center.slug);
  const exp = stamp?.experienceSlug
    ? experiences.find((e) => e.slug === stamp.experienceSlug)
    : undefined;
  if (!exp) {
    throw new EditGuardError(
      "qamf_availability",
      "cannot resolve the QAMF web offer for a lane-count rebook (no experience stamp)",
    );
  }
  // Duration change: the new lane-time length is a QAMF Time option — it only
  // applies on the freshly created reservation.
  const newDuration = primaryLeg.newDuration;
  return rebookQamfForLaneChange({
    neonId: anchor.id,
    qamfCenterId: center.qamfCenterId,
    qamfReservationId: anchor.qamfReservationId,
    bookedAt: anchor.bookedAt,
    webOfferId: exp.qamfWebOfferId,
    optionId: newDuration?.qamfOptionId || (exp.qamfOptionId ?? undefined),
    optionType: newDuration
      ? "Time"
      : ((exp.qamfOptionType as "Game" | "Time" | "Unlimited" | null) ?? undefined),
    newPlayerCount: primaryLeg.newPlayerCount ?? anchor.playerCount ?? 1,
    existing: {
      guestName: anchor.guestName,
      guestPhone: anchor.guestPhone,
      guestEmail: anchor.guestEmail,
      notes: anchor.notes,
      comboSpecialId: anchor.comboSpecialId,
    },
  });
};

/**
 * Refund `owedCents` across the money group's payments — prior edit top-ups
 * first (newest first: undo edits before touching the original deposit), then
 * the deposit order's tenders in order.
 *
 * Money rules (live finding 2026-07-11 + verify pass):
 *  1. NET stranded refunds first — refunds recorded by non-completed attempts
 *     (crashed / failed / this attempt's own resume) already returned money
 *     against this same order value; without netting, a retry restarts from
 *     the full owed amount and over-refunds later tenders.
 *  2. Pre-flight capacity check — plan every refund amount BEFORE any money
 *     moves. Square refuses PARTIAL refunds of gift-card-funded tenders
 *     (full is fine), so a mid-flight shortfall would strand a partial card
 *     refund and a store-credit re-run would double-compensate the guest.
 */
const refundAcrossTenders = async (
  editId: string,
  anchor: BowlingReservation,
  plan: EditPlan,
  owedCents: number,
  refundIds: string[],
): Promise<{ refundedCents: number; giftCardTendersSkipped: number }> => {
  const targets: RefundTarget[] = [];
  const events = await listEditEventsByAnchors(plan.legIds);
  for (const ev of events) {
    if (ev.state !== "completed") continue;
    for (const pid of [...(ev.paymentIds ?? [])].reverse()) {
      targets.push({ paymentId: pid, label: `edit ${ev.editId}` });
    }
  }
  if (anchor.squareDepositOrderId) {
    const deposit = await fetchOrderFacts(anchor.squareDepositOrderId);
    for (const t of deposit.tenders) {
      targets.push({ paymentId: t.paymentId, label: "deposit" });
    }
  }
  const targetIds = new Set(targets.map((t) => t.paymentId));

  // 1. Stranded-refund netting. A completed event's refunds are already
  //    settled (its order/Neon changes committed) — only refunds that no
  //    completed event has absorbed count as stranded.
  const absorbedIds = new Set(
    events.filter((e) => e.state === "completed").flatMap((e) => e.refundIds ?? []),
  );
  const strandedIds = [
    ...new Set(events.filter((e) => e.state !== "completed").flatMap((e) => e.refundIds ?? [])),
  ].filter((id) => !absorbedIds.has(id));
  let strandedCents = 0;
  for (const rid of strandedIds) {
    const f = await fetchRefundFacts(rid);
    if (f.status === "FAILED" || f.status === "REJECTED") continue;
    if (!targetIds.has(f.paymentId)) continue;
    strandedCents += f.amountCents;
    // Absorb the stranded refund into THIS event so completion accounts for
    // it and later decreases stop netting it.
    if (!refundIds.includes(rid)) refundIds.push(rid);
    await recordEditRefund(editId, rid);
  }
  const owed = Math.max(0, owedCents - strandedCents);

  // 2. Pre-flight plan — no Square mutation until the whole amount is known
  //    coverable.
  const planned: Array<{ paymentId: string; amountCents: number }> = [];
  let giftCardTendersSkipped = 0;
  let toCover = owed;
  for (const target of targets) {
    if (toCover <= 0) break;
    const pay = await fetchPaymentFacts(target.paymentId);
    const tenderRemaining = pay.amountCents - pay.refundedCents;
    if (tenderRemaining <= 0) continue;
    if (pay.sourceType === "GIFT_CARD" && toCover < tenderRemaining) {
      // Guests can fund deposits partly with their own gift card
      // (authorizeMultiTender); Square refuses partial refunds of those.
      giftCardTendersSkipped++;
      continue;
    }
    const amount = Math.min(toCover, tenderRemaining);
    planned.push({ paymentId: target.paymentId, amountCents: amount });
    toCover -= amount;
  }
  if (toCover > 0) {
    throw new Error(
      `cannot refund ${owed} of ${owedCents} cents: refundable tenders cover only ${owed - toCover}` +
        (giftCardTendersSkipped > 0
          ? ` (${giftCardTendersSkipped} gift-card tender(s) skipped — Square refuses partial gift-card refunds)`
          : "") +
        ` — NO money was refunded; re-run this edit with store-credit settlement`,
    );
  }

  // 3. Execute. The key index starts past refunds already recorded on THIS
  //    event so a same-attempt resume never reuses a burned key with a new
  //    body.
  let index = (events.find((e) => e.editId === editId)?.refundIds ?? []).length;
  let refunded = 0;
  for (const p of planned) {
    const r = await refundTenderPartial({
      editId,
      refundIndex: index,
      paymentId: p.paymentId,
      amountCents: p.amountCents,
      // Owner convention (2026-07-11): reservation-money refunds carry this
      // exact reason so they read consistently in the Square dashboard/exports.
      reason: "Refund: Reservation Deposit",
      skipGiftCardTender: true,
    });
    if (r.skippedGiftCard) giftCardTendersSkipped++;
    if (r.refundId) {
      refundIds.push(r.refundId);
      await recordEditRefund(editId, r.refundId);
    }
    refunded += r.refundedCents;
    index++;
  }
  return { refundedCents: strandedCents + refunded, giftCardTendersSkipped };
};

/**
 * Store credit for an edit DECREASE: load the reservation's existing
 * store-credit card when one exists; otherwise comp-mint a new Square-GAN
 * card for exactly the reduction (persisted to Neon immediately after the
 * card exists). The paired adjust_gift_card_down step keeps the internal
 * deposit card == day-of total.
 */
const issueEditStoreCredit = async (
  editId: string,
  anchor: BowlingReservation,
  amountCents: number,
  fallbackLocationId: string,
): Promise<string> => {
  const locationId = anchor.squareGiftCardId
    ? ((await fetchGiftCardFacts(anchor.squareGiftCardId)).locationId ?? fallbackLocationId)
    : fallbackLocationId;

  if (anchor.storeCreditGiftCardId && anchor.storeCreditGiftCardGan) {
    await loadGiftCard({
      giftCardId: anchor.storeCreditGiftCardId,
      locationId,
      amountCents,
      baseKey: `${editId}-sc`,
      buyerPaymentInstrumentIds: [],
    });
    await updateStoreCreditIssued(anchor.id, {
      giftCardId: anchor.storeCreditGiftCardId,
      gan: anchor.storeCreditGiftCardGan,
      cents: (anchor.storeCreditCents ?? 0) + amountCents,
      state: "issued",
    });
    return anchor.storeCreditGiftCardGan;
  }

  const discountId =
    process.env.SQUARE_STORE_CREDIT_DISCOUNT_CATALOG_ID ||
    process.env.SQUARE_SURVEY_DISCOUNT_CATALOG_ID ||
    "37C3SN4245TUCN3RF7XMNKPU";
  const minted = await mintDigitalGiftCard({
    locationId,
    amountCents,
    baseKey: editId,
    discountCatalogObjectId: discountId,
    customerId: anchor.squareCustomerId,
  });
  await updateStoreCreditIssued(anchor.id, {
    giftCardId: minted.giftCardId,
    gan: minted.gan,
    cents: amountCents,
    state: "issued",
  });
  return minted.gan;
};

/**
 * Post-complete rebuild: for each leg, create a NEW order with the desired
 * lines (no fulfillment — nothing may hit the KDS after the session), pay it
 * fully from the internal gift card, complete it, and swap the Neon pointer.
 * The old order was already refunded by refund_dayof_order.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
const rebuildAndSettleDayofOrders = async (
  editId: string,
  anchor: BowlingReservation,
  plan: EditPlan,
): Promise<Array<{ oldOrderId: string; newOrderId: string }>> => {
  const pairs: Array<{ oldOrderId: string; newOrderId: string }> = [];
  let n = 0;
  for (const leg of plan.legs) {
    if (!leg.dayofOrderId || !leg.orderLocationId) continue;
    const oldOrderId = leg.dayofOrderId;
    // Rebuild with the source order's catalog taxes/discounts.
    const src = await sq("GET", `/orders/${leg.dayofOrderId}`);
    const catalogRefs = (arr: any[] | undefined) =>
      (arr ?? [])
        .filter((t: any) => t.catalog_object_id)
        .map((t: any) => ({ catalog_object_id: t.catalog_object_id, scope: t.scope ?? "ORDER" }));
    const createRes = await sq("POST", "/orders", {
      idempotency_key: `${editId}-neworder-${n}`,
      order: {
        location_id: leg.orderLocationId,
        ...(anchor.squareCustomerId ? { customer_id: anchor.squareCustomerId } : {}),
        line_items: leg.newLines.map((l: PlanLine) => ({
          ...(l.catalogObjectId ? { catalog_object_id: l.catalogObjectId } : { name: l.name }),
          quantity: String(l.quantity),
          base_price_money: { amount: l.unitPriceCents, currency: "USD" },
          ...(l.note ? { note: l.note } : {}),
        })),
        ...(src.ok && src.json?.order?.taxes ? { taxes: catalogRefs(src.json.order.taxes) } : {}),
        ...(src.ok && src.json?.order?.discounts
          ? { discounts: catalogRefs(src.json.order.discounts) }
          : {}),
      },
    });
    if (!createRes.ok || !createRes.json?.order?.id) {
      throw new Error(`rebuild order create failed (${createRes.status})`);
    }
    const newOrder = createRes.json.order;
    const newOrderId: string = newOrder.id;
    const newTotal: number = newOrder.total_money?.amount ?? 0;
    if (newTotal !== leg.newTotalCents) {
      throw new Error(`rebuilt order total ${newTotal} != planned ${leg.newTotalCents}`);
    }

    if (newTotal > 0) {
      if (!anchor.squareGiftCardId)
        throw new Error("no deposit gift card to pay the rebuilt order");
      const payRes = await sq("POST", "/payments", {
        idempotency_key: `${editId}-repay-${n}`,
        source_id: anchor.squareGiftCardId,
        amount_money: { amount: newTotal, currency: "USD" },
        order_id: newOrderId,
        location_id: leg.orderLocationId,
        autocomplete: true,
        note: `Reservation edit #${anchor.id} — rebuilt day-of order`,
      });
      if (!payRes.ok) throw new Error(`rebuilt order payment failed (${payRes.status})`);
    }

    // Complete it (no fulfillment → completes cleanly; loyalty NOT re-accrued).
    const fresh = await sq("GET", `/orders/${newOrderId}`);
    const version = fresh.ok ? (fresh.json?.order?.version ?? 1) : 1;
    if (fresh.ok && fresh.json?.order?.state !== "COMPLETED") {
      const complete = await sq("PUT", `/orders/${newOrderId}`, {
        idempotency_key: `${editId}-complete-${n}`,
        order: { location_id: leg.orderLocationId, version, state: "COMPLETED" },
      });
      if (!complete.ok) throw new Error(`rebuilt order complete failed (${complete.status})`);
    }
    pairs.push({ oldOrderId, newOrderId });
    leg.dayofOrderId = newOrderId; // commitNeon persists the swap
    n++;
  }
  return pairs;
};
/* eslint-enable @typescript-eslint/no-explicit-any */

const commitNeon = async (
  plan: EditPlan,
  req: ExecuteEditRequest,
  newQamfReservationId?: string,
  rebuiltOrders: Array<{ oldOrderId: string; newOrderId: string }> = [],
): Promise<void> => {
  for (const leg of plan.legs) {
    if (!leg.newNeonLines) continue; // race legs keep their lines (BMI-driven)
    const lines: ReservationLine[] = leg.newNeonLines.map((l) => ({
      squareProductId: l.squareProductId ?? undefined,
      label: l.label,
      quantity: l.quantity,
      unitPriceCents: l.unitPriceCents,
    }));
    await updateReservationAfterEdit(leg.reservationId, {
      lines,
      playerCount: leg.newPlayerCount ?? undefined,
      totalCents: leg.newTotalCents,
      // PRE phase keeps the deposit == day-of total invariant; later phases
      // leave the recorded deposit (already spent) untouched.
      depositCents: plan.phase === "pre" ? leg.newTotalCents : undefined,
      // Self-heal: persist the stamp the plan resolved for THIS leg (stamped
      // or derived — legacy rows gain booking_metadata.bowling on their first
      // successful edit). Carry-mode legs resolve nothing and leave the row's
      // metadata untouched.
      bowlingStamp: leg.resolvedStamp
        ? {
            ...leg.resolvedStamp,
            ...(leg.newLaneCount != null ? { laneCount: leg.newLaneCount } : {}),
            ...(leg.newDuration ? { durationMultiplier: leg.newDuration.multiplier } : {}),
          }
        : undefined,
      players: req.plan.spec.players?.map((p) => ({
        slot: p.slot,
        name: p.name,
        shoeSize: p.shoeSize ?? null,
        bumpers: p.bumpers ?? null,
      })),
      qamfReservationId: newQamfReservationId,
      appendNote: `[edit ${new Date().toISOString().slice(0, 16)}Z] ${plan.phase} diff ${(plan.diffCents / 100).toFixed(2)} (${plan.settlement})${rebuiltOrders.length > 0 ? ` — order rebuilt (was ${rebuiltOrders.map((p) => p.oldOrderId).join(",")})` : ""}`,
    });
  }

  // Post-complete: swap the order pointer + re-stamp completion so the
  // status-close cron stays away from the new order.
  if (plan.phase === "post_complete") {
    const { sql } = await import("@/lib/db");
    const q = sql();
    for (const leg of plan.legs) {
      if (!leg.dayofOrderId) continue;
      await q`
        UPDATE bowling_reservations
        SET square_dayof_order_id = ${leg.dayofOrderId},
            dayof_order_sent_at = COALESCE(dayof_order_sent_at, NOW())
        WHERE id = ${leg.reservationId}
      `;
    }
  }
};
