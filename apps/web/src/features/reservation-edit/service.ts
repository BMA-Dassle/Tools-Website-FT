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
  markEditPendingPayment,
  nextEditAttempt,
  recordEditPayment,
  startEditEvent,
  listEditEventsByAnchors,
} from "@/lib/reservation-edit-log";
import { getLatestCancelEvent } from "@/lib/reservation-cancel-log";
import { loadGiftCard, mintDigitalGiftCard, refundSquarePayment } from "@/lib/square-gift-card";
import redis from "@/lib/redis";
import { recordAdminAction } from "~/features/reservations-admin/audit";
import { fetchGiftCardFacts, fetchOrderFacts, sq } from "~/features/cancellation/square-actions";
import { resolveCenter } from "~/features/cancellation/centers";

import type { EditPlan, EditPlanLeg, PlanLine } from "./plan";
import {
  adjustGiftCardDown,
  chargeDayofOrder,
  createEditTopupOrderAndCharge,
  refundTenderPartial,
  updateDayofOrderLines,
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
    lockHeld = (await redis.set(lockKey, "1", "EX", 180, "NX")) === "OK";
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
    if (kinds.has("refund_dayof_payment") && !flag("RESERVATION_EDIT_V2_MID_DECREASE")) {
      throw new EditGuardError(
        "mid_session_unsupported",
        "mid-session decreases are not enabled yet (RESERVATION_EDIT_V2_MID_DECREASE)",
      );
    }
    if (kinds.has("refund_dayof_order") && !flag("RESERVATION_EDIT_V2_POST")) {
      throw new EditGuardError(
        "post_complete_ack_required",
        "post-complete edits are not enabled yet (RESERVATION_EDIT_V2_POST)",
      );
    }

    // ── Audit row (fatal) ──────────────────────────────────────────────
    const attempt = req.resumeEditId
      ? parseInt(req.resumeEditId.match(/-a(\d+)$/)?.[1] ?? "1", 10)
      : await nextEditAttempt(anchorId);
    const editId = req.resumeEditId ?? `edit-${anchorId}-a${attempt}`;
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
            const refunded = await refundAcrossTenders(editId, anchor, plan, owed, refundIds);
            if (refunded < owed) {
              throw new Error(
                `could only refund ${refunded} of ${owed} cents across known tenders — manual follow-up`,
              );
            }
            stepLog.push({ step: step.kind, ok: true, detail: `-${refunded}` });
            break;
          }

          case "refund_dayof_payment": {
            if (!anchor.dayofPaymentId) throw new Error("no lane-open payment id on the row");
            const r = await refundTenderPartial({
              editId,
              refundIndex: 90, // reserved namespace for the gift-card tender refund
              paymentId: anchor.dayofPaymentId,
              amountCents: step.amountCents ?? -plan.diffCents,
              reason: `Reservation edit #${anchorId} — mid-session reduction`,
            });
            if (r.refundId) refundIds.push(r.refundId);
            stepLog.push({ step: step.kind, ok: true, detail: r.refundId });
            break;
          }

          case "issue_store_credit": {
            const amount = step.amountCents ?? -plan.diffCents;
            storeCreditGan = await issueEditStoreCredit(editId, anchor, amount, chargeLocationId);
            stepLog.push({ step: step.kind, ok: true, detail: storeCreditGan });
            break;
          }

          case "adjust_gift_card_down": {
            if (!plan.giftCard) break;
            const adjusted = await adjustGiftCardDown({
              editId,
              giftCardId: plan.giftCard.id,
              amountCents: step.amountCents ?? -plan.diffCents,
            });
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
                reason: `Reservation edit #${anchorId} — rebuild after completion`,
              });
              refundIds.push(r.refundId);
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
            await commitNeon(anchor, plan, req, newQamfReservationId, rebuiltOrders);
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
 */
const refundAcrossTenders = async (
  editId: string,
  anchor: BowlingReservation,
  plan: EditPlan,
  owedCents: number,
  refundIds: string[],
): Promise<number> => {
  const targets: RefundTarget[] = [];
  const priorEdits = await listEditEventsByAnchors(plan.legIds);
  for (const ev of priorEdits) {
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

  let remaining = owedCents;
  let index = 0;
  for (const target of targets) {
    if (remaining <= 0) break;
    const r = await refundTenderPartial({
      editId,
      refundIndex: index,
      paymentId: target.paymentId,
      amountCents: remaining,
      reason: `Reservation edit #${anchor.id} — price reduction (${target.label})`,
    });
    if (r.refundId) refundIds.push(r.refundId);
    remaining -= r.refundedCents;
    index++;
  }
  return owedCents - remaining;
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
  anchor: BowlingReservation,
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
    const stamp = (anchor.bookingMetadata as { bowling?: Record<string, unknown> })?.bowling;
    await updateReservationAfterEdit(leg.reservationId, {
      lines,
      playerCount: leg.newPlayerCount ?? undefined,
      totalCents: leg.newTotalCents,
      // PRE phase keeps the deposit == day-of total invariant; later phases
      // leave the recorded deposit (already spent) untouched.
      depositCents: plan.phase === "pre" ? leg.newTotalCents : undefined,
      bowlingStamp:
        stamp && (leg.newLaneCount != null || leg.newDuration)
          ? {
              ...stamp,
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
