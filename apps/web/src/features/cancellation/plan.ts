/**
 * Cancellation plan builder — resolves the money group, runs every guard, and
 * live-fetches the Square facts, producing the ordered step list the service
 * executes. Read-only: building a plan never mutates anything, which is what
 * makes the admin modal's dry-run preview safe to run on every open.
 */
import {
  getBowlingReservation,
  listCancelGroupReservations,
  type BowlingReservation,
} from "@/lib/bowling-db";
import { nextCancelAttempt } from "@/lib/reservation-cancel-log";
import {
  classifyMoney,
  gameZoneCents,
  guardActorOutcome,
  guardCustomerCutoff,
  guardDayofOrder,
  guardRefundTotal,
  legLabel,
  tenderRefundsNeeded,
  type TenderRefund,
} from "./guards";
import { fetchGiftCardFacts, fetchOrderFacts, fetchPaymentFacts } from "./square-actions";
import {
  CancelGuardError,
  type CancelOutcome,
  type CancelPlan,
  type CancelRequest,
  type GatheredFacts,
  type PlannedStep,
} from "./types";

export type BuildPlanResult =
  | { kind: "already_cancelled"; legs: BowlingReservation[] }
  | { kind: "plan"; plan: CancelPlan };

export async function buildCancelPlan(req: CancelRequest): Promise<BuildPlanResult> {
  const anchor = await getBowlingReservation(req.neonId);
  if (!anchor) throw new CancelGuardError("not_found", "Reservation not found.", 404);

  const legs = await listCancelGroupReservations(anchor);
  const activeLegs = legs.filter((l) => l.status !== "cancelled");
  const allCancelled = activeLegs.length === 0;
  if (allCancelled && !req.resumeTeardown) {
    return { kind: "already_cancelled", legs };
  }

  const isCombo = legs.some((l) => !!l.comboSpecialId);
  const warnings: string[] = [];

  guardActorOutcome({
    isCombo,
    actor: req.actor,
    outcome: req.outcome,
    allowCustomerRefund: req.allowCustomerRefund,
  });
  if (req.resumeTeardown && req.actor !== "admin") {
    throw new CancelGuardError("refund_requires_admin", "Teardown resume is staff-only.", 403);
  }
  if (req.actor === "customer") {
    guardCustomerCutoff(activeLegs, Date.now());
  }

  if (legs.length > activeLegs.length && !allCancelled) {
    warnings.push(
      `${legs.length - activeLegs.length} leg(s) of this booking were already cancelled — ` +
        `this cancel repairs the remaining leg(s).`,
    );
  }

  // ── Money facts ────────────────────────────────────────────────────────────
  // One deposit / one internal gift card per group; the "money leg" is whichever
  // row carries the shared instruments.
  const moneyLeg =
    legs.find((l) => l.squareGiftCardId) ?? legs.find((l) => l.squareDepositPaymentId);
  const moneyClass = classifyMoney(legs);
  if (moneyClass === "broken") {
    throw new CancelGuardError(
      "gift_card_unavailable",
      "A deposit payment exists but no deposit gift card — the refund amount can't be " +
        "derived safely. Handle this one manually in Square, then re-run.",
      409,
    );
  }

  const facts: GatheredFacts = { payments: {}, dayofOrders: {} };
  let outcome: CancelOutcome = moneyClass === "zero" ? "none" : req.outcome;
  if (allCancelled) {
    // Teardown resume: the settlement already happened — honor what was recorded.
    outcome = (anchor.cancellationOutcome as CancelOutcome | undefined) ?? "none";
  }
  let amountCents = 0;
  let refundsNeeded: TenderRefund[] = [];
  let existingStoreCredit: CancelPlan["existingStoreCredit"];

  if (moneyClass === "funded" && moneyLeg?.squareGiftCardId) {
    facts.giftCard = await fetchGiftCardFacts(moneyLeg.squareGiftCardId);

    const depositOrderId = legs.find((l) => l.squareDepositOrderId)?.squareDepositOrderId;
    if (depositOrderId) {
      const dep = await fetchOrderFacts(depositOrderId);
      facts.depositOrder = {
        id: dep.id,
        tenders: [...dep.tenders].sort((a, b) => (a.paymentId < b.paymentId ? -1 : 1)),
        // Kiosk Game Zone cards ride the deposit order as extra ITEM lines: the
        // reader payment covers deposit + cards, but the internal gift card
        // holds the deposit only. Their total is excluded from refunds — the
        // guest keeps the cards (owner 2026-07-26).
        gameZoneCents: gameZoneCents(dep.lineItems),
      };
      for (const t of facts.depositOrder.tenders) {
        facts.payments[t.paymentId] = await fetchPaymentFacts(t.paymentId);
      }
    } else if (moneyLeg.squareDepositPaymentId) {
      // Oldest rows: payment recorded without a deposit order — single-tender shape.
      facts.depositOrder = {
        id: "",
        tenders: [{ paymentId: moneyLeg.squareDepositPaymentId, amountCents: 0 }],
      };
      const pay = await fetchPaymentFacts(moneyLeg.squareDepositPaymentId);
      facts.payments[pay.id] = pay;
      facts.depositOrder.tenders[0].amountCents = pay.amountCents;
    }

    // Cancel-awareness of EDITS: an edit-increase splits the group's money
    // across the original deposit order AND edit top-up payments
    // (reservation_edit_events is the ledger). Fold completed edit payments
    // into the tender set so a post-edit cancel refunds them too — without
    // this the guest is under-refunded by every top-up they ever paid.
    if (facts.depositOrder) {
      try {
        const { listEditEventsByAnchors } = await import("@/lib/reservation-edit-log");
        const editEvents = await listEditEventsByAnchors(legs.map((l) => l.id));
        const known = new Set(facts.depositOrder.tenders.map((t) => t.paymentId));
        for (const ev of editEvents) {
          if (ev.state !== "completed") continue;
          for (const paymentId of ev.paymentIds ?? []) {
            if (known.has(paymentId)) continue;
            known.add(paymentId);
            const pay = await fetchPaymentFacts(paymentId);
            facts.payments[paymentId] = pay;
            // editTopup: edits never sell Game Zone cards, so the gz exclusion
            // must not land on these tenders.
            facts.depositOrder.tenders.push({
              paymentId,
              amountCents: pay.amountCents,
              editTopup: true,
            });
          }
        }
      } catch (err) {
        warnings.push(
          `Edit-payment lookup failed (${err instanceof Error ? err.message : "error"}) — ` +
            "verify no edit top-ups are being missed before refunding.",
        );
      }
    }

    refundsNeeded = tenderRefundsNeeded(facts);
    const neededCents = refundsNeeded.reduce((s, r) => s + r.amountCents, 0);
    const priorRefundCents = Object.values(facts.payments).reduce((s, p) => s + p.refundedCents, 0);

    const gzCents = facts.depositOrder?.gameZoneCents ?? 0;
    if (gzCents > 0) {
      warnings.push(
        `Game Zone cards ($${(gzCents / 100).toFixed(2)}) purchased with this booking stay ` +
          `with the guest — that amount is not refunded or credited.`,
      );
    }

    if (outcome === "refund") {
      if (neededCents > 0) {
        guardRefundTotal({
          refundsNeededCents: neededCents,
          gcBalanceCents: facts.giftCard.balanceCents,
        });
        if (facts.giftCard.state !== "ACTIVE") {
          throw new CancelGuardError(
            "gift_card_unavailable",
            `Deposit gift card is ${facts.giftCard.state} while ${neededCents}¢ is still ` +
              `unrefunded — manual review in Square.`,
            409,
          );
        }
        amountCents = neededCents;
      } else {
        amountCents = priorRefundCents;
        if (priorRefundCents > 0)
          warnings.push("Deposit already fully refunded — no new refund will be issued.");
      }
    } else if (outcome === "store_credit") {
      const sc = legs.find((l) => l.storeCreditGiftCardId);

      // An EDIT-issued store credit lives in the SAME store_credit_* columns
      // this planner reads. Left unchecked, the branch below would treat an
      // item refund's card as "the cancel's store credit, already issued" and
      // report its (small) cents as the cancel amount — silently stranding the
      // rest of the deposit. The two are not interchangeable: the edit's card
      // settled a partial refund, while the cancel still owes the internal
      // gift card's remaining balance. Refuse rather than under-credit;
      // supporting it properly means computing state as
      // (original − item refunds), which lands with the MID-decrease work.
      if (sc?.storeCreditGiftCardId) {
        const { listEditEventsByAnchors } = await import("@/lib/reservation-edit-log");
        const editEvents = await listEditEventsByAnchors(legs.map((l) => l.id));
        const editIssued = editEvents.some(
          (e) => e.state === "completed" && e.storeCreditGiftCardId === sc.storeCreditGiftCardId,
        );
        if (editIssued) {
          throw new CancelGuardError(
            "amount_mismatch",
            `Store credit card ${sc.storeCreditGiftCardGan ?? sc.storeCreditGiftCardId} was issued ` +
              `by a reservation EDIT, not by a cancellation — reusing it here would credit only ` +
              `that edit's amount and strand the rest of the deposit. Handle this cancel manually ` +
              `in Square.`,
            409,
          );
        }
      }

      if (sc?.storeCreditGiftCardId && sc.storeCreditGiftCardGan) {
        existingStoreCredit = {
          giftCardId: sc.storeCreditGiftCardId,
          gan: sc.storeCreditGiftCardGan,
          cents: sc.storeCreditCents,
          state: sc.storeCreditState ?? "issuing",
        };
        amountCents = sc.storeCreditCents;
        warnings.push(
          "A store-credit card was already issued for this booking — it will be reused, not re-minted.",
        );
      } else {
        if (priorRefundCents > 0) {
          throw new CancelGuardError(
            "amount_mismatch",
            `${priorRefundCents}¢ was already refunded to the card — issuing store credit on top ` +
              `would double-pay. Handle manually in Square.`,
            409,
          );
        }
        if (facts.giftCard.state !== "ACTIVE" || facts.giftCard.balanceCents <= 0) {
          throw new CancelGuardError(
            "nothing_to_credit",
            `Deposit gift card is ${facts.giftCard.state} with ${facts.giftCard.balanceCents}¢ — ` +
              `there is nothing to convert to store credit.`,
            409,
          );
        }
        amountCents = facts.giftCard.balanceCents;
      }
    }
  } else if (req.outcome === "store_credit" && moneyClass === "zero" && !allCancelled) {
    // The request asked for a card, but nothing was ever charged — surface it
    // rather than silently downgrading to a plain cancel.
    throw new CancelGuardError(
      "nothing_to_credit",
      "Nothing was charged for this booking — there is no amount to put on a gift card.",
      409,
    );
  }

  // ── Day-of orders (every distinct order across the WHOLE group) ────────────
  const dayofIds = [
    ...new Set(legs.map((l) => l.squareDayofOrderId).filter((v): v is string => !!v)),
  ];
  for (const oid of dayofIds) {
    const o = await fetchOrderFacts(oid);
    facts.dayofOrders[oid] = o;
    if (guardDayofOrder(o) === "refuse") {
      throw new CancelGuardError(
        "dayof_order_tendered",
        `Day-of order ${oid} was already paid (${o.tenderCount} tender(s), state=${o.state}) — ` +
          `the deposit is no longer cleanly on the gift card. Manual path in Square.`,
        409,
      );
    }
  }

  // ── Ordered steps ──────────────────────────────────────────────────────────
  const steps: PlannedStep[] = [];
  const D = (c: number) => `$${(c / 100).toFixed(2)}`;

  if (outcome === "refund") {
    for (const r of refundsNeeded) {
      steps.push({
        kind: "refund_tender",
        fatal: true,
        target: r.paymentId,
        detail:
          `Refund ${D(r.amountCents)} to the original card (payment ${r.paymentId})` +
          (r.partial ? ` — Game Zone card purchase stays with the guest` : ""),
        amountCents: r.amountCents,
      });
    }
  } else if (outcome === "store_credit" && !existingStoreCredit) {
    steps.push({
      kind: "issue_store_credit",
      fatal: true,
      target: facts.giftCard?.id ?? "",
      detail: `Issue a ${D(amountCents)} HeadPinz FastTrax Gift Card (new Square card number) funded by the deposit`,
      amountCents,
    });
  }

  for (const leg of activeLegs) {
    steps.push({
      kind: "mark_cancelled",
      fatal: true,
      legId: leg.id,
      target: String(leg.id),
      detail: `Mark ${legLabel(leg)} reservation #${leg.id} cancelled`,
    });
  }

  for (const oid of dayofIds) {
    if (guardDayofOrder(facts.dayofOrders[oid]) === "cancel") {
      steps.push({
        kind: "cancel_dayof_order",
        fatal: false,
        target: oid,
        detail: `Cancel the open day-of Square order ${oid} (${D(facts.dayofOrders[oid].totalCents)})`,
      });
    }
  }

  if (facts.giftCard && facts.giftCard.state === "ACTIVE") {
    // Store-credit issuance drains as part of its own (fatal) step; the refund
    // path drains here. Deactivation applies to both.
    if (outcome === "refund" && facts.giftCard.balanceCents > 0) {
      steps.push({
        kind: "drain_internal_gc",
        fatal: false,
        target: facts.giftCard.id,
        detail: `Zero out the internal deposit card ${facts.giftCard.gan} (${D(facts.giftCard.balanceCents)})`,
      });
    }
    steps.push({
      kind: "deactivate_internal_gc",
      fatal: false,
      target: facts.giftCard.id,
      detail: `Deactivate the internal deposit card ${facts.giftCard.gan}`,
    });
  }

  for (const leg of activeLegs) {
    if ((leg.productKind === "open" || leg.productKind === "kbf") && leg.qamfReservationId) {
      steps.push({
        kind: "delete_qamf",
        fatal: false,
        legId: leg.id,
        target: leg.qamfReservationId,
        detail: `Delete the QAMF lane reservation ${leg.qamfReservationId}`,
      });
    }
  }

  // BMI projects — deduped by bill (mixed race+attraction carts share one bill).
  // ALL legs included: already-cancelled projects short-circuit inside, which
  // heals legacy partial cancels.
  const bmiSeen = new Set<string>();
  for (const leg of legs) {
    if (
      (leg.productKind === "race" || leg.productKind === "attraction") &&
      leg.bmiBillId &&
      !bmiSeen.has(leg.bmiBillId)
    ) {
      bmiSeen.add(leg.bmiBillId);
      steps.push({
        kind: "cancel_bmi_project",
        fatal: false,
        legId: leg.id,
        target: leg.bmiBillId,
        detail: `Cancel the BMI ${leg.productKind} reservation (bill ${leg.bmiBillId}${leg.bmiReservationNumber ? ` / ${leg.bmiReservationNumber}` : ""})`,
      });
    }
  }

  for (const leg of legs) {
    if (leg.attractionBookings?.length) {
      steps.push({
        kind: "cancel_bmi_addons",
        fatal: false,
        legId: leg.id,
        target: String(leg.id),
        detail: `Cancel ${leg.attractionBookings.length} BMI attraction add-on(s) on reservation #${leg.id}`,
      });
    }
  }

  for (const leg of activeLegs) {
    if (leg.squareLoyaltyRewardId) {
      steps.push({
        kind: "delete_loyalty_reward",
        fatal: false,
        legId: leg.id,
        target: leg.squareLoyaltyRewardId,
        detail: `Return loyalty points (delete reward ${leg.squareLoyaltyRewardId})`,
      });
    }
    if (leg.promoCode && leg.squareDayofOrderId) {
      steps.push({
        kind: "refund_promo_redemption",
        fatal: false,
        legId: leg.id,
        target: leg.squareDayofOrderId,
        detail: `Release the ${leg.promoCode} coupon redemption`,
      });
    }
  }

  const attempt = await nextCancelAttempt(anchor.id);
  const plan: CancelPlan = {
    cascadeId: `cxl-${anchor.id}-a${attempt}`,
    attempt,
    anchorId: anchor.id,
    legIds: legs.map((l) => l.id),
    legs,
    isCombo,
    outcome,
    amountCents,
    steps,
    facts,
    warnings,
    existingStoreCredit,
  };
  return { kind: "plan", plan };
}
