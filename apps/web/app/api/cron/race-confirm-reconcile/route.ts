import { NextRequest, NextResponse } from "next/server";
import redis from "@/lib/redis";
import { buildGanPrefix } from "@/lib/gan";
import {
  getPendingBmiConfirms,
  getConfirmedRowsWithUnfundedGiftCard,
  getBowlingReservationByBillId,
  updateBowlingReservationConfirmed,
  updateBowlingReservationSquareIds,
  incrementQamfConfirmAttempt,
  MAX_QAMF_CONFIRM_ATTEMPTS,
  type BowlingReservation,
} from "@/lib/bowling-db";
import { confirmBmiPayment } from "~/features/booking/service/bmi-confirm";
import {
  activateGiftCardForDeposit,
  getDepositOrderLineItem,
} from "~/features/booking/service/deposit";
import { reserveBaseKey } from "~/features/booking/service/reserve-idempotency";
import { SQUARE_LOCATIONS } from "~/features/booking/data/square-catalog-map";
import { verifyCron } from "@/lib/cron-auth";

/**
 * GET /api/cron/race-confirm-reconcile
 *
 * Forward-recovery for the v2 race / attraction reserve paths (blocker #2). The
 * deposit is CAPTURED inside createDepositAndCharge BEFORE the gift card is
 * created and BEFORE BMI confirm. If a later step fails, the reserve route
 * leaves a durable `confirm_pending` / `confirm_failed` anchor row (with the
 * captured Square ids) instead of rolling back — a captured payment can't be
 * voided and the funds back the gift card. This cron drives those rows forward:
 *
 *   1. Gift card never funded (giftCardPending) → re-run create + activate
 *      against the SAME deterministic baseKey (idempotent, no double-load) and
 *      backfill the ids.
 *   2. BMI already confirmed (bmi:confirmed cache present) → just promote the
 *      row to `confirmed` (covers the "charged + confirmed but Neon write
 *      failed" regression).
 *   3. BMI not yet confirmed → confirm it (race = $0 credit), write the
 *      bmi:confirmed cache, set Pandora state -3, then promote the row.
 *
 * Once `confirmed`, race-dayof-pay settles it at check-in — closing the
 * "charged + confirmed but no row → never settles" gap.
 *
 * SECOND PASS — confirmed-but-unfunded backfill (added after the Freytag W41982
 * incident, 2026-06-27): a row can reach `confirmed` while its deposit gift card
 * was never funded (create/activate failed, square_gift_card_id never persisted).
 * Such a row is invisible to BOTH getPendingBmiConfirms (not pending) AND
 * race-dayof-pay (needs square_gift_card_id), so its day-of order sits OPEN
 * forever. getConfirmedRowsWithUnfundedGiftCard finds them; backfillConfirmedRow
 * funds the card ONLY — it must never re-confirm BMI (already confirmed) nor
 * downgrade the row's status. race-dayof-pay then settles it normally.
 *
 * Auth mirrors race-dayof-pay: scheduled runs use verifyCron; a valid
 * ?token=<ADMIN_CAMERA_TOKEN> bypasses it for manual / dev runs. ?dryRun=1
 * reports without writing. ?billId=<id> reconciles a single bill.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const PANDORA_LOCATION_IDS: Record<string, string> = {
  "fort-myers": "TXBSQN0FEKQ11",
  fasttrax: "LAB52GY480CJF",
  naples: "PPTR5G2N0QXF7",
};

function depositLocationId(r: BowlingReservation): string {
  if (r.productKind === "race") return SQUARE_LOCATIONS.FASTTRAX_FM;
  return r.centerCode === "naples" ? SQUARE_LOCATIONS.HEADPINZ_NAP : SQUARE_LOCATIONS.HEADPINZ_FM;
}

function bmiClientKey(centerCode: string): string {
  return centerCode === "naples" ? "headpinznaples" : "headpinzftmyers";
}

interface ReconcileOutcome {
  label: string;
  status: "confirmed" | "requeued" | "failed" | "skipped";
  note: string;
}

/** Set the project state to -3 (Confirmation) via Pandora — mirror of the
 *  reserve paths' BMI_AUTOCANCEL_WORKAROUND. Non-fatal. */
async function setPandoraConfirmation(r: BowlingReservation, bmiBillId: string): Promise<void> {
  try {
    const projectIdNum = (Number(bmiBillId.slice(-10)) + 1).toString();
    const projectId = bmiBillId.slice(0, -projectIdNum.length) + projectIdNum;
    const pandoraKey = process.env.SWAGGER_ADMIN_KEY || "";
    const pandoraLocationId =
      r.productKind === "race"
        ? "LAB52GY480CJF"
        : (PANDORA_LOCATION_IDS[r.centerCode] ?? "TXBSQN0FEKQ11");
    const res = await fetch("https://bma-pandora-api.azurewebsites.net/v2/bmi/reservation/state", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${pandoraKey}` },
      body: JSON.stringify({ locationID: pandoraLocationId, projectId, stateID: "-3" }),
      signal: AbortSignal.timeout(10_000),
    });
    console.log(
      `[race-confirm-reconcile] Pandora project ${projectId} state → -3: ${res.ok ? "OK" : res.status}`,
    );
  } catch (err) {
    console.error("[race-confirm-reconcile] Pandora state update failed (non-fatal):", err);
  }
}

/**
 * Step-1 funding (shared): re-create + activate the deposit gift card for a row
 * whose card was never funded after capture, then persist the ids. Idempotent —
 * keyed off the deterministic reserveBaseKey, so a replay returns the SAME card
 * with no double-load. Returns the row updated with the new ids (or the input row
 * unchanged when there is nothing to fund). Throws on a Square failure so the
 * caller can decide how to record it. Used by BOTH the pending-reconcile path and
 * the confirmed-but-unfunded backfill.
 */
async function fundGiftCardIfNeeded(r: BowlingReservation): Promise<BowlingReservation> {
  if (r.squareGiftCardId || !r.squareDepositPaymentId || r.depositCents <= 0 || !r.bmiBillId) {
    return r;
  }
  // If the deposit order's line item is a GIFT_CARD sale (v2 model), recover via
  // the order link so the recovered card is also booked as a gift-card sale;
  // otherwise fall back to the legacy buyer_payment_instrument path. Keyed off the
  // order's actual line-item type, not the live flag, so a retry always matches
  // how the order was originally created.
  let orderLink: { depositOrderId: string; lineItemUid: string } | undefined;
  if (r.squareDepositOrderId) {
    const li = await getDepositOrderLineItem(r.squareDepositOrderId);
    if (li?.itemType === "GIFT_CARD" && li.uid) {
      orderLink = { depositOrderId: r.squareDepositOrderId, lineItemUid: li.uid };
    }
  }
  const { giftCardId, giftCardGan } = await activateGiftCardForDeposit({
    baseKey: reserveBaseKey(r.bmiBillId),
    locationId: depositLocationId(r),
    amountCents: r.depositCents,
    ganPrefix: buildGanPrefix("WEB", depositLocationId(r)),
    ganSuffix: r.bmiBillId.slice(-8),
    paymentIds: [r.squareDepositPaymentId],
    ...(orderLink ?? {}),
  });
  await updateBowlingReservationSquareIds(r.id, {
    squareGiftCardId: giftCardId,
    squareGiftCardGan: giftCardGan,
  });
  console.log(
    `[race-confirm-reconcile] ${r.bmiReservationNumber ?? "?"} (neon ${r.id}): gift card funded (${giftCardGan})`,
  );
  return { ...r, squareGiftCardId: giftCardId, squareGiftCardGan: giftCardGan };
}

/**
 * Backfill an already-`confirmed` row whose gift card was never funded. ONLY
 * funds the card — BMI is already confirmed, so this must NOT re-confirm, and on
 * failure it must NOT touch qamf_confirm_attempts / status (downgrading a
 * confirmed row would be a regression). Once funded, race-dayof-pay settles it.
 */
async function backfillConfirmedRow(
  r: BowlingReservation,
  dryRun: boolean,
): Promise<ReconcileOutcome> {
  const label = `${r.bmiReservationNumber ?? "?"} (neon ${r.id})`;
  if (dryRun) return { label, status: "requeued", note: "would: fund gift card (confirmed row)" };
  try {
    const funded = await fundGiftCardIfNeeded(r);
    if (funded.squareGiftCardId && funded.squareGiftCardId !== r.squareGiftCardId) {
      return { label, status: "confirmed", note: `gift card funded (${funded.squareGiftCardGan})` };
    }
    return { label, status: "skipped", note: "nothing to fund" };
  } catch (err) {
    const detail = err instanceof Error ? err.message : "funding error";
    // Do NOT change status — the row is genuinely confirmed; only the card is
    // unfunded. Surface for ops; the next cron pass retries (idempotent).
    console.error(
      `[race-confirm-reconcile] ${label}: confirmed-row gift-card funding FAILED — guest=${r.guestName} depositCents=${r.depositCents}: ${detail}`,
    );
    return { label, status: "failed", note: `confirmed-row funding failed: ${detail}` };
  }
}

async function reconcileRow(r: BowlingReservation, dryRun: boolean): Promise<ReconcileOutcome> {
  const label = `${r.bmiReservationNumber ?? "?"} (neon ${r.id})`;
  const bmiBillId = r.bmiBillId;
  if (!bmiBillId) return { label, status: "skipped", note: "no bmiBillId" };

  const attemptsAfter = r.qamfConfirmAttempts + 1;
  const terminal = attemptsAfter >= MAX_QAMF_CONFIRM_ATTEMPTS;

  // Attraction rows confirm for a non-$0 amount we don't durably store, so we
  // can't safely re-confirm one whose BMI confirm genuinely failed. The common
  // case (BMI confirmed, only the Neon promotion failed) is still handled below
  // via the cache short-circuit; otherwise flag for manual handling.
  const cached = await redis.get(`bmi:confirmed:${bmiBillId}`).catch(() => null);

  if (dryRun) {
    const plan: string[] = [];
    if (!r.squareGiftCardId && r.squareDepositPaymentId && r.depositCents > 0)
      plan.push("fund gift card");
    plan.push(cached ? "promote (already confirmed)" : "confirm BMI");
    return { label, status: "requeued", note: `would: ${plan.join(" + ")}` };
  }

  try {
    // ── 1. Gift card never funded after capture → re-create + activate ──
    r = await fundGiftCardIfNeeded(r);

    // ── 2. BMI already confirmed → just promote the row ──
    if (cached) {
      const c = (typeof cached === "string" ? JSON.parse(cached) : cached) as {
        reservationNumber?: string;
      };
      await updateBowlingReservationConfirmed(r.id, {
        bmiReservationNumber: c.reservationNumber ?? r.bmiReservationNumber ?? undefined,
      });
      return { label, status: "confirmed", note: "promoted (BMI already confirmed)" };
    }

    // ── 3. BMI not confirmed → confirm forward (race = $0 credit only) ──
    if (r.productKind !== "race") {
      // Non-race amount isn't recoverable from the row; don't risk a wrong-amount
      // re-confirm. Let it sit until the attempt budget marks it for manual review.
      await incrementQamfConfirmAttempt(r.id, terminal ? "confirm_failed" : "confirm_pending");
      if (terminal)
        console.error(
          `[race-confirm-reconcile] ${label}: attraction confirm needs MANUAL INTERVENTION`,
        );
      return {
        label,
        status: terminal ? "failed" : "requeued",
        note: "attraction: no cached confirm; cannot re-confirm safely",
      };
    }

    const bmiResult = await confirmBmiPayment({
      clientKey: bmiClientKey(r.centerCode),
      bmiBillId,
      amountCents: 0,
      asCredit: true,
    });
    const reservationNumber = bmiResult.reservationNumber;
    if (reservationNumber) {
      await redis
        .set(
          `bmi:confirmed:${bmiBillId}`,
          JSON.stringify({
            reservationNumber,
            reservationCode: bmiResult.reservationCode ?? `r${bmiBillId}`,
            orderId: bmiBillId,
          }),
          "EX",
          86400 * 7,
        )
        .catch(() => {});
    }
    await setPandoraConfirmation(r, bmiBillId);
    await updateBowlingReservationConfirmed(r.id, {
      bmiReservationNumber: reservationNumber ?? r.bmiReservationNumber ?? undefined,
    });
    return { label, status: "confirmed", note: `confirmed (resNum=${reservationNumber})` };
  } catch (err) {
    const detail = err instanceof Error ? err.message : "reconcile error";
    await incrementQamfConfirmAttempt(r.id, terminal ? "confirm_failed" : "confirm_pending");
    if (terminal)
      console.error(
        `[race-confirm-reconcile] ${label}: CONFIRM_FAILED after ${attemptsAfter} attempts` +
          ` — depositCents=${r.depositCents} guest=${r.guestName} — MANUAL INTERVENTION REQUIRED: ${detail}`,
      );
    return { label, status: terminal ? "failed" : "requeued", note: detail };
  }
}

export async function GET(req: NextRequest) {
  // Auth: scheduled runs use the cron Bearer; a valid admin ?token= bypasses it
  // so the cron can be invoked MANUALLY (dev + ops). verifyCron short-circuits in
  // non-prod, so the manual token is the only way to exercise it locally.
  const manualToken = req.nextUrl.searchParams.get("token");
  const isManual =
    !!process.env.ADMIN_CAMERA_TOKEN && manualToken === process.env.ADMIN_CAMERA_TOKEN;
  if (!isManual) {
    const denied = verifyCron(req);
    if (denied) return denied;
  }

  const dryRun = req.nextUrl.searchParams.get("dryRun") === "1";
  const started = Date.now();

  // Single-bill manual reconcile (?billId=…).
  const manualBillId = req.nextUrl.searchParams.get("billId");
  if (manualBillId) {
    const r = await getBowlingReservationByBillId(manualBillId);
    if (!r) return NextResponse.json({ error: "reservation not found" }, { status: 404 });
    // Pending/failed → full reconcile (fund + BMI confirm).
    if (["confirm_pending", "confirm_failed"].includes(r.status)) {
      const outcome = await reconcileRow(r, dryRun);
      return NextResponse.json({ ok: outcome.status !== "failed", dryRun, ...outcome });
    }
    // Already confirmed but the deposit gift card was never funded → fund only
    // (never re-confirm BMI). This is the Freytag W41982 gap.
    if (
      r.status === "confirmed" &&
      !r.squareGiftCardId &&
      r.squareDepositPaymentId &&
      r.totalCents > 0 &&
      !r.dayofOrderSentAt
    ) {
      const outcome = await backfillConfirmedRow(r, dryRun);
      return NextResponse.json({ ok: outcome.status !== "failed", dryRun, ...outcome });
    }
    return NextResponse.json({
      ok: true,
      billId: manualBillId,
      status: r.status,
      note: "not pending",
    });
  }

  const pending = await getPendingBmiConfirms();
  const results = { attempted: 0, confirmed: 0, requeued: 0, failed: 0, skipped: 0 };
  const outcomes: ReconcileOutcome[] = [];

  for (const r of pending) {
    results.attempted++;
    let outcome: ReconcileOutcome;
    try {
      outcome = await reconcileRow(r, dryRun);
    } catch (err) {
      outcome = {
        label: `${r.bmiReservationNumber ?? "?"} (neon ${r.id})`,
        status: "failed",
        note: err instanceof Error ? err.message : "unexpected error",
      };
    }
    results[outcome.status]++;
    outcomes.push(outcome);
  }

  // Backfill already-`confirmed` rows whose deposit gift card was never funded —
  // the gap that left Freytag W41982's day-of order OPEN forever (skipped by both
  // getPendingBmiConfirms and race-dayof-pay). Fund-only; no BMI re-confirm.
  const unfunded = await getConfirmedRowsWithUnfundedGiftCard();
  for (const r of unfunded) {
    results.attempted++;
    let outcome: ReconcileOutcome;
    try {
      outcome = await backfillConfirmedRow(r, dryRun);
    } catch (err) {
      outcome = {
        label: `${r.bmiReservationNumber ?? "?"} (neon ${r.id})`,
        status: "failed",
        note: err instanceof Error ? err.message : "unexpected error",
      };
    }
    results[outcome.status]++;
    outcomes.push(outcome);
  }

  console.log(
    `[race-confirm-reconcile] dryRun=${dryRun} pending=${pending.length} unfundedConfirmed=${unfunded.length} confirmed=${results.confirmed} requeued=${results.requeued} failed=${results.failed}`,
  );
  return NextResponse.json({
    ok: true,
    dryRun,
    elapsedMs: Date.now() - started,
    pending: pending.length,
    unfundedConfirmed: unfunded.length,
    ...results,
    outcomes,
  });
}
