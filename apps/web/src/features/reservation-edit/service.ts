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

import { refundFlagForPhase } from "./guards";
import type { EditPlan, EditPlanLeg, PlanLine } from "./plan";
import {
  adjustGiftCardDown,
  chargeDayofOrder,
  createEditTopupOrderAndCharge,
  createReturnOrder,
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
    // A1 was OVERTURNED on 2026-07-27 by an owner-authorized live probe: the
    // API DOES accept partial refunds of gift-card-funded payments. The flags
    // stay off until the §8 smoke checklist in
    // tasks/future/post-dayof-refund-plan.md passes.
    //
    // Gate on the PLAN'S PHASE, not on the step kind. refund_dayof_payment is
    // emitted by BOTH mid and post_complete (money-only is the preferred shape
    // in each), so keying off the kind mapped the wrong flag onto each phase:
    // _MID_DECREASE silently governed post-complete refunds, and _POST governed
    // only the rebuild path — meaning enabling _POST alone did nothing for the
    // post-complete refund we actually build, while enabling _MID_DECREASE
    // alone opened post-complete refunds nobody signed off on.
    if (kinds.has("refund_dayof_payment") || kinds.has("refund_dayof_order")) {
      const required = refundFlagForPhase(plan.phase);
      if (!required) {
        // Only mid/post_complete emit these steps. A pre-phase plan carrying one
        // has nothing to refund (no tender on the day-of order yet), so this is
        // a corrupted plan rather than a permission question — refuse it before
        // it picks a flag by accident.
        throw new EditGuardError(
          "phase_conflict",
          `plan is ${plan.phase} but carries a paid-order refund step — refusing to move money`,
        );
      }
      if (!flag(required)) {
        throw new EditGuardError(
          "refund_not_enabled",
          plan.phase === "post_complete"
            ? `refunds after the visit is closed are not enabled yet (${required})`
            : `refunds after check-in are not enabled yet (${required})`,
        );
      }
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
    /** Return orders created for itemized refunds — surfaced in the step log. */
    const returnOrderIds: string[] = [];
    /**
     * What the day-of leg ACTUALLY returned, per Square's itemized return
     * total. Once set it overrides the planner's figures for the guest refund
     * and the gift-card decrement so all three legs move the same money.
     */
    let dayofRefundedCents: number | undefined;
    /** Gift-card balance immediately BEFORE the day-of refund was issued. */
    let gcBaselineCents: number | undefined;
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
            // When a day-of leg already ran, the amount SQUARE returned is the
            // truth — not the planner's estimate. The itemized return makes
            // Square compute the tax-inclusive figure, and it can differ from
            // local math (a live smoke on 2026-07-27 had the planner at 866¢
            // and Square at 642¢). Refunding the planner's number here while
            // the card only got Square's would over-refund the guest by the
            // difference, and leave the gift-card decrement inconsistent too.
            const owed = dayofRefundedCents ?? step.amountCents ?? -plan.diffCents;
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

            // ITEMIZED, never amount-only (owner rule 2026-07-27). Build a
            // return order naming the exact lines coming off the paid order;
            // Square computes the tax-inclusive total, and that figure is what
            // we refund. Without this the returned item is invisible to
            // item-level sales reporting and to QBO categorization.
            //
            // An order-linked refund does NOT credit the gift-card tender
            // (probed 2026-07-28, three arms, controlled: linked stayed at 0¢
            // past 150s; identical unlinked credited in ~11s; destination_id
            // made no difference). That is fine — the card side is handled
            // deterministically by reconcile_gift_card instead of waiting on
            // Square's credit, which removes the async window that stranded
            // the 7/27 credit on card ...1430 altogether.
            const legWithReturn = plan.legs.find(
              (l) => l.dayofOrderId && l.returnedLines.length > 0,
            );
            if (!legWithReturn?.dayofOrderId || !legWithReturn.orderLocationId) {
              throw new Error(
                "cannot identify which line items are being refunded — a day-of refund must be " +
                  "itemized against the paid order, never issued as a bare amount",
              );
            }
            // Snapshot the card BEFORE the refund so the wait step can tell
            // when the credit has actually landed (refund status lags).
            if (plan.giftCard) {
              try {
                gcBaselineCents = (await fetchGiftCardFacts(plan.giftCard.id)).balanceCents;
              } catch {
                gcBaselineCents = undefined; // wait falls back to the status signal
              }
            }
            const ret = await createReturnOrder({
              editId,
              sourceOrderId: legWithReturn.dayofOrderId,
              locationId: legWithReturn.orderLocationId,
              lines: legWithReturn.returnedLines.map((l) => ({
                uid: l.uid,
                quantity: l.quantity,
              })),
            });
            returnOrderIds.push(ret.returnOrderId);
            // Square's own tax-inclusive figure wins over the planner's, and
            // becomes the amount every later leg uses.
            const asked = ret.returnTotalCents;
            dayofRefundedCents = asked;
            if (step.amountCents != null && step.amountCents !== asked) {
              stepLog.push({
                step: "return_order",
                ok: true,
                detail: `${ret.returnOrderId} — Square priced the return at ${asked}¢ (plan said ${step.amountCents}¢)`,
              });
            } else {
              stepLog.push({ step: "return_order", ok: true, detail: ret.returnOrderId });
            }

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
              // Linked to the return order → the refund is ITEMIZED, matching
              // how the POS records returns. It will NOT credit the gift card;
              // reconcile_gift_card handles the card side deterministically.
              returnOrderId: ret.returnOrderId,
            });
            if (r.refundId) {
              refundIds.push(r.refundId);
              await recordEditRefund(editId, r.refundId);
            }
            stepLog.push({ step: step.kind, ok: true, detail: r.refundId });
            break;
          }

          case "reconcile_gift_card": {
            // The internal card must end holding exactly what it held before
            // the refund — the value being returned belongs to the guest, not
            // to the card.
            //
            // An ITEMIZED refund does not credit the card, so in the normal
            // case the balance is already correct and this is a verified
            // no-op. But we do not ASSUME that: we compare against the
            // baseline captured before the refund and decrement any excess.
            // That keeps the step correct if Square ever starts crediting
            // order-linked refunds, and it replaces the old
            // wait-then-decrement pair — no async window, so nothing can be
            // stranded the way the 7/27 credit on card ...1430 was.
            if (!plan.giftCard) {
              throw new Error(
                "gift card facts unavailable — cannot verify the card holds no refunded value",
              );
            }
            const live = (await fetchGiftCardFacts(plan.giftCard.id)).balanceCents;
            const baseline = gcBaselineCents ?? live;
            const excess = live - baseline;
            if (excess > 0) {
              const dropped = await adjustGiftCardDown({
                editId,
                giftCardId: plan.giftCard.id,
                amountCents: excess,
              });
              if (dropped < excess) {
                throw new Error(
                  `gift card ${plan.giftCard.id} still holds refunded value ` +
                    `(dropped ${dropped}¢ of ${excess}¢) — resolve in Square before retrying`,
                );
              }
              stepLog.push({
                step: step.kind,
                ok: true,
                detail: `-${dropped} (credit had posted)`,
              });
            } else {
              stepLog.push({
                step: step.kind,
                ok: true,
                detail: `balance ${live}¢ unchanged vs baseline — nothing to strip`,
              });
            }
            break;
          }

          case "issue_store_credit": {
            const amount = step.amountCents ?? -plan.diffCents;
            storeCreditGan = await issueEditStoreCredit(editId, anchor, amount, chargeLocationId);
            stepLog.push({ step: step.kind, ok: true, detail: storeCreditGan });
            break;
          }

          case "adjust_gift_card_down": {
            // Same rule as refund_tender: strip exactly what came back.
            const want = dayofRefundedCents ?? step.amountCents ?? plan.gcDecrementCents;
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
): Promise<{ refundedCents: number }> => {
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
  //    coverable. GIFT_CARD tenders refund partially like any other: the
  //    2026-07-27 live probe overturned the "Square refuses partial gift-card
  //    refunds" claim the old skip here cited, and the plan side
  //    (plan.ts refund-capacity loop) already counted GC capacity — the skip
  //    made the executor throw on decreases the plan had approved. Under
  //    ambient gift cards a GC often carries most of the deposit, so partial
  //    GC refunds are the NORMAL decrease path, not an edge case.
  const planned: Array<{ paymentId: string; amountCents: number }> = [];
  let toCover = owed;
  for (const target of targets) {
    if (toCover <= 0) break;
    const pay = await fetchPaymentFacts(target.paymentId);
    const tenderRemaining = pay.amountCents - pay.refundedCents;
    if (tenderRemaining <= 0) continue;
    const amount = Math.min(toCover, tenderRemaining);
    planned.push({ paymentId: target.paymentId, amountCents: amount });
    toCover -= amount;
  }
  if (toCover > 0) {
    throw new Error(
      `cannot refund ${owed} of ${owedCents} cents: refundable tenders cover only ${owed - toCover}` +
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
      // No gift-card skip: partial GC refunds are legal (2026-07-27 probe) and
      // routine under ambient gift cards — the plan above already counted them.
    });
    if (r.refundId) {
      refundIds.push(r.refundId);
      await recordEditRefund(editId, r.refundId);
    }
    refunded += r.refundedCents;
    index++;
  }
  return { refundedCents: strandedCents + refunded };
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

  // Only a REBUILD moves the order pointer (rebuildDayofOrder reassigns
  // leg.dayofOrderId). The money-only post-complete path leaves the original
  // order in place carrying its refunds, so re-pointing it would write the same
  // id back — a pointless statement that made a pure-refund edit depend on a
  // Neon write it does not need. Swap only when something was actually rebuilt.
  if (rebuiltOrders.length > 0) {
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
