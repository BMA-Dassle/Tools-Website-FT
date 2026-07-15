import { NextRequest, NextResponse } from "next/server";
import { buildGanPrefix } from "@/lib/gan";
import {
  getGfQuoteByShortId,
  updateGfDepositPaid,
  updateGfDepositAttempt,
  updateGfDepositChargeCaptured,
  updateGfGiftCardList,
  appendAuditLog,
  parseGiftCardIds,
  parseGiftCardGans,
  type GroupFunctionQuote,
} from "@/lib/group-function-db";
import { notifyDepositPaid } from "@/lib/group-function-notify";
import {
  authorizeMultiTender,
  mintDigitalGiftCard,
  createDigitalGiftCard,
  loadBalanceOntoGiftCards,
  sumGiftCardLoadsForPayment,
  getGiftCardBalanceCents,
  findOrCreateSquareCustomer,
  SquarePaymentError,
} from "@/lib/square-gift-card";
import { createDayofOrder } from "@/lib/group-function-dayof";
import { giftCardSaleEnabled, giftCardSaleChunks } from "~/features/booking/service/deposit";
import { serviceChargeCentsFromLineItems, buildPaymentLineItems } from "@/lib/service-charge";
import { firePortalWebhookAsync } from "@/lib/portal-webhook";
import { notifyDispatchError } from "@/lib/group-function-alert";
import { isCardDeclineCode } from "@/lib/square-decline";

// Per-line Square rounding can make the day-of order total differ from our stored
// total by a few cents. A larger gap means the displayed contract is stale — halt
// the charge rather than bill an amount the customer never saw.
const DEPOSIT_MISMATCH_TOLERANCE_CENTS = 50;

/**
 * Group function deposit payment endpoint.
 *
 * POST /api/group-function/deposit
 *
 * Called after the customer signs the PandaDoc contract on the
 * /contract/{shortId} page. Collects the deposit via Square,
 * creates an eGift card (GRPF prefix), and optionally saves
 * the card on file for the 72-hour balance charge.
 *
 * Charge-safety invariants (H3074 six-charge incident, 2026-07-14):
 *  - Idempotency keys derive from (quote, deposit_attempts) — a double-click
 *    resolves to the SAME Square order + payment.
 *  - Gift cards are CREATED before the charge; only activation (which cannot
 *    take money) runs after. A pre-charge failure never costs the guest.
 *  - The instant a charge captures, its ids are persisted (persist-first).
 *    A later failure leaves a findable record, and the next attempt RESUMES
 *    fulfillment from that payment instead of charging again.
 *  - A custom-GAN collision ("The Gift Card has already been created") is
 *    recovered by reusing the colliding PENDING card or falling back to a
 *    Square-generated GAN — it can no longer brick every retry.
 */

const SQUARE_BASE = "https://connect.squareup.com/v2";
const SQUARE_TOKEN = process.env.SQUARE_ACCESS_TOKEN || "";
const SQUARE_VERSION = "2024-12-18";
const LEGACY_DEPOSIT_DISCOUNT_ID =
  process.env.SQUARE_LEGACY_DEPOSIT_DISCOUNT_ID || "RN4EW6G4KYCGZ3HYI4AHMZSB";

function computePriorDepositCents(quote: GroupFunctionQuote): number {
  const payments = (quote.prior_payments ?? []) as Array<{ amount: number }>;
  return Math.round(payments.reduce((sum, p) => sum + (p.amount || 0), 0) * 100);
}

function sqHeaders() {
  return {
    Authorization: `Bearer ${SQUARE_TOKEN}`,
    "Content-Type": "application/json",
    "Square-Version": SQUARE_VERSION,
  };
}

/** Contract-history ledger row for a failed/declined deposit payment (best-effort). */
function auditDepositFailure(
  quote: GroupFunctionQuote,
  fields: { code: string; error: string; amountCents: number; attempt: number; charged: boolean },
): void {
  appendAuditLog({
    quoteId: quote.id,
    event: isCardDeclineCode(fields.code) ? "deposit_declined" : "deposit_payment_failed",
    metadata: {
      code: fields.code,
      error: fields.error.slice(0, 300),
      amountCents: fields.amountCents,
      attempt: fields.attempt,
      chargeCaptured: fields.charged,
    },
  }).catch((err) => console.error("[gf-deposit] audit log error:", err));
}

/** Fetch a Square payment; returns it only when the money actually captured. */
async function getCompletedPayment(
  paymentId: string,
): Promise<{ id: string; amountCents: number; orderId?: string; sourceType?: string } | null> {
  try {
    const res = await fetch(`${SQUARE_BASE}/payments/${encodeURIComponent(paymentId)}`, {
      headers: sqHeaders(),
    });
    const data = await res.json();
    if (!res.ok || data.payment?.status !== "COMPLETED") return null;
    return {
      id: data.payment.id as string,
      amountCents: data.payment.amount_money?.amount ?? 0,
      orderId: data.payment.order_id as string | undefined,
      sourceType: data.payment.source_type as string | undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Create (never activate) the day-of gift cards — one per ≤$2k chunk — with the
 * persisted GAN scheme. Collision-safe: a PENDING card left by an earlier failed
 * attempt (or a prior contract version) is reused; an ACTIVE one is never merged
 * into (Square generates a fresh GAN instead). Runs BEFORE the charge so a
 * failure here costs the guest nothing.
 */
async function ensureDepositGiftCards(
  quote: GroupFunctionQuote,
  chunks: number[],
  keyBase: string,
  existingIds: string[] = [],
  existingGans: string[] = [],
): Promise<{ gcIds: string[]; gcGans: string[] }> {
  const prefix = quote.gan_prefix || buildGanPrefix("GF", quote.square_location_id);
  const ganSuffix = quote.bmi_reservation_id.slice(-8);
  const baseGan = `${prefix}${ganSuffix}`.replace(/[^A-Za-z0-9]/g, "");

  const gcIds = [...existingIds];
  const gcGans = [...existingGans];
  for (let i = gcIds.length; i < chunks.length; i++) {
    const suffix = i === 0 ? "" : String.fromCharCode(65 + i); // "", "B", "C", ...
    const customGan = `${baseGan}${suffix}`;
    const useCustomGan = customGan.length >= 8 && customGan.length <= 20;
    const card = await createDigitalGiftCard({
      locationId: quote.square_location_id,
      idempotencyKey: `gfgc-${keyBase}-${i}`,
      customGan: useCustomGan ? customGan : undefined,
    });
    if (card.reused) {
      console.log(`[gf-deposit] reused PENDING gift card ${card.gan} (GAN collision recovery)`);
    }
    gcIds.push(card.id);
    gcGans.push(card.gan);
  }
  return { gcIds, gcGans };
}

interface FinalizeDepositArgs {
  quote: GroupFunctionQuote;
  depositOrderId: string;
  depositPaymentId: string;
  /** Card payment id when a real card was tendered — the CreateCard source. */
  cardPaymentId?: string;
  paymentIds: string[];
  depositCents: number;
  effectiveTotalCents: number;
  saveCard: boolean;
  gcIds: string[];
  gcGans: string[];
  saleMode: boolean;
  lineItemUids: string[];
  chunks: number[];
  dayofOrderId?: string;
}

/**
 * Everything that happens AFTER the deposit charge captures: activate the gift
 * cards, save the card on file, mark the quote paid, notify. Shared by the
 * fresh-charge path and the resume path. Only the mark-paid DB write may throw;
 * every Square/BMI side effect in here is best-effort because the money is
 * already captured — failing the request would push the guest to pay again.
 */
async function finalizeDeposit(a: FinalizeDepositArgs): Promise<{
  giftCardGan: string;
  balanceCents: number;
}> {
  const { quote } = a;

  // 1. Activate one card per chunk. Keys derive from the payment id so every
  //    resume retries the SAME activations. An already-active card (a prior
  //    attempt finished it) shows up as an activation error with the funds
  //    present — verified via balance before alerting.
  for (let i = 0; i < a.chunks.length; i++) {
    const gcId = a.gcIds[i];
    if (!gcId) continue;
    try {
      const actRes = await fetch(`${SQUARE_BASE}/gift-cards/activities`, {
        method: "POST",
        headers: sqHeaders(),
        body: JSON.stringify({
          idempotency_key: `gfact-${a.depositPaymentId}-${i}`,
          gift_card_activity: {
            type: "ACTIVATE",
            location_id: quote.square_location_id,
            gift_card_id: gcId,
            activate_activity_details:
              a.saleMode && a.lineItemUids[i]
                ? { order_id: a.depositOrderId, line_item_uid: a.lineItemUids[i] }
                : {
                    amount_money: { amount: a.chunks[i], currency: "USD" },
                    buyer_payment_instrument_ids: a.paymentIds,
                  },
          },
        }),
      });
      const actData = await actRes.json();
      if (!actRes.ok || actData.errors) {
        const alreadyFunded = await getGiftCardBalanceCents(gcId)
          .then((b) => b >= a.chunks[i])
          .catch(() => false);
        if (!alreadyFunded) {
          console.error(`[gf-deposit] gift card #${i} activation failed:`, actData);
          notifyDispatchError({
            reservationId: quote.bmi_reservation_id,
            centerName: quote.center_name,
            plannerEmail: quote.planner_email ?? undefined,
            error: new Error(
              `Deposit captured (payment ${a.depositPaymentId}) but gift card ${a.gcGans[i] || gcId} ` +
                `failed to activate for $${(a.chunks[i] / 100).toFixed(2)} — needs manual activation.`,
            ),
          }).catch(() => {});
        }
      } else {
        console.log(
          `[gf-deposit] gift card #${i + 1}/${a.chunks.length}: ${a.gcGans[i]} ` +
            `activated $${(a.chunks[i] / 100).toFixed(2)} (saleMode=${a.saleMode})`,
        );
      }
    } catch (err) {
      console.error(`[gf-deposit] gift card #${i} activation error:`, err);
    }
  }

  const giftCardId = JSON.stringify(a.gcIds);
  const giftCardGan = JSON.stringify(a.gcGans);

  // 2. Customer + card on file for the 72-hour auto-charge (best-effort).
  // Square requires: charge first → use the paymentId as source_id for CreateCard.
  // See: https://developer.squareup.com/docs/cards-api/walkthrough/card-from-payment-id
  let squareCustomerId: string | undefined;
  try {
    squareCustomerId = (await findOrCreateSquareCustomer(quote)) ?? undefined;
  } catch (err) {
    console.error("[gf-deposit] customer lookup/create error:", err);
  }

  let savedCardId: string | undefined;
  let savedCardLast4: string | undefined;
  let savedCardBrand: string | undefined;
  if (a.saveCard && a.cardPaymentId && squareCustomerId) {
    try {
      const cardRes = await fetch(`${SQUARE_BASE}/cards`, {
        method: "POST",
        headers: sqHeaders(),
        body: JSON.stringify({
          idempotency_key: `gfcard-${a.depositPaymentId}`,
          source_id: a.cardPaymentId,
          card: { customer_id: squareCustomerId },
        }),
      });
      const cardData = await cardRes.json();
      if (cardRes.ok && cardData.card?.id) {
        savedCardId = cardData.card.id;
        savedCardLast4 = cardData.card.last_4 || undefined;
        savedCardBrand = cardData.card.card_brand || undefined;
        console.log(
          `[gf-deposit] card saved: ${savedCardId} (${savedCardBrand} ...${savedCardLast4}) for customer ${squareCustomerId}`,
        );
      } else {
        console.error("[gf-deposit] card save FAILED:", JSON.stringify(cardData).slice(0, 500));
      }
    } catch (err) {
      console.error("[gf-deposit] card save error:", err);
    }
  }

  // 3. Mark paid — the one write that must succeed.
  const balanceCents = a.effectiveTotalCents - a.depositCents;
  await updateGfDepositPaid(quote.id, {
    square_deposit_order_id: a.depositOrderId,
    square_deposit_payment_id: a.depositPaymentId,
    square_gift_card_id: giftCardId,
    square_gift_card_gan: giftCardGan,
    square_customer_id: squareCustomerId,
    saved_card_id: savedCardId,
    square_dayof_order_id: a.dayofOrderId,
    deposit_paid_at: new Date().toISOString(),
    balance_cents: balanceCents,
  });

  if (savedCardLast4 || savedCardBrand) {
    const { sql: sqlFn } = await import("@/lib/db");
    const q = sqlFn();
    await q`UPDATE group_function_quotes SET
      saved_card_last4 = ${savedCardLast4 ?? null},
      saved_card_brand = ${savedCardBrand ?? null}
    WHERE id = ${quote.id}`;
  }

  // Notify guest + planner (non-blocking)
  const updatedQuote = await getGfQuoteByShortId(quote.contract_short_id!);
  if (updatedQuote) {
    notifyDepositPaid(updatedQuote).catch((err) =>
      console.error("[gf-deposit] notify error:", err),
    );
  }

  // Confirm BMI + record the deposit payment + note. Best-effort AFTER capture —
  // a BMI hiccup must not surface as a payment error (the guest would pay again).
  try {
    const { confirmAndRecordBmiPayment } = await import("@/lib/bmi-office-actions");
    await confirmAndRecordBmiPayment({
      centerCode: quote.center_code,
      projectId: quote.bmi_reservation_id,
      lineItems: (quote.line_items || []) as Array<{ name: string }>,
      amountDollars: a.depositCents / 100,
      note: `Deposit paid: $${(a.depositCents / 100).toFixed(2)} | GAN: ${giftCardGan} | Balance: $${(balanceCents / 100).toFixed(2)}`,
      contractUrl: `${quote.base_url || "https://fasttraxent.com"}/contract/${quote.contract_short_id}`,
    });
  } catch (err) {
    console.error("[gf-deposit] BMI confirm/record failed (deposit already captured):", err);
    notifyDispatchError({
      reservationId: quote.bmi_reservation_id,
      centerName: quote.center_name,
      plannerEmail: quote.planner_email ?? undefined,
      error: new Error(
        `Deposit paid for "${quote.event_name}" but BMI confirm/payment record failed: ${err instanceof Error ? err.message : String(err)}`,
      ),
    }).catch(() => {});
  }

  firePortalWebhookAsync("payment.deposit_paid", {
    documentId: quote.contract_short_id,
    bmiCode: quote.bmi_reservation_id,
    venue: quote.center_code,
    status: "deposit_paid",
  });

  // Generate signed PDF server-side (non-fatal to deposit)
  try {
    const { generateAndStorePdf } = await import("@/lib/contract-pdf-generate");
    await generateAndStorePdf(quote.contract_short_id!);
  } catch (err) {
    console.error("[gf-deposit] PDF generation failed:", err);
  }

  return { giftCardGan, balanceCents };
}

/**
 * Resume path: a prior attempt CAPTURED the deposit charge but died before the
 * quote was marked paid (the persist-first marker is set). Verify the payment
 * actually completed, recover the order/card context, and finish fulfillment —
 * without a new charge. Returns null when there is nothing to resume (the
 * caller proceeds with a fresh charge).
 */
async function tryResumeCapturedDeposit(
  quote: GroupFunctionQuote,
  saveCard: boolean,
): Promise<NextResponse | null> {
  const paymentId = quote.square_deposit_payment_id;
  if (!paymentId || paymentId.startsWith("legacy-comp-")) return null;

  const payment = await getCompletedPayment(paymentId);
  if (!payment || payment.amountCents <= 0) return null;

  const depositCents = payment.amountCents;
  const depositOrderId = quote.square_deposit_order_id || payment.orderId;
  if (!depositOrderId) return null;

  console.log(
    `[gf-deposit] RESUME quote=${quote.id} payment=${paymentId} ` +
      `($${(depositCents / 100).toFixed(2)} already captured) — skipping charge`,
  );

  // Recover sale-mode + line uids from the deposit order itself (the env flag
  // may have flipped since the charge; the order is the truth).
  let saleMode = false;
  let lineItemUids: string[] = [];
  try {
    const oRes = await fetch(`${SQUARE_BASE}/orders/${encodeURIComponent(depositOrderId)}`, {
      headers: sqHeaders(),
    });
    const oData = await oRes.json();
    if (oRes.ok) {
      const gcItems = (
        (oData.order?.line_items ?? []) as Array<{ uid?: string; item_type?: string }>
      ).filter((li) => li.item_type === "GIFT_CARD");
      if (gcItems.length > 0) {
        saleMode = true;
        lineItemUids = gcItems.map((li) => li.uid ?? "");
      }
    }
  } catch {
    /* legacy (amount + instruments) activation works without uids */
  }

  const chunks = giftCardSaleChunks(depositCents);
  let gcIds = parseGiftCardIds(quote.square_gift_card_id);
  let gcGans = parseGiftCardGans(quote.square_gift_card_gan);
  if (gcIds.length < chunks.length) {
    const ensured = await ensureDepositGiftCards(
      quote,
      chunks,
      paymentId.slice(-18),
      gcIds,
      gcGans,
    );
    gcIds = ensured.gcIds;
    gcGans = ensured.gcGans;
  }

  // Effective total: prefer the day-of order's tax-inclusive total when we have it.
  let effectiveTotalCents = quote.total_cents;
  if (quote.square_dayof_order_id) {
    try {
      const dRes = await fetch(
        `${SQUARE_BASE}/orders/${encodeURIComponent(quote.square_dayof_order_id)}`,
        { headers: sqHeaders() },
      );
      const dData = await dRes.json();
      if (dRes.ok && typeof dData.order?.total_money?.amount === "number") {
        effectiveTotalCents = dData.order.total_money.amount;
      }
    } catch {
      /* fall back to stored total */
    }
  }

  const fin = await finalizeDeposit({
    quote,
    depositOrderId,
    depositPaymentId: paymentId,
    cardPaymentId: payment.sourceType === "CARD" ? paymentId : undefined,
    paymentIds: [paymentId],
    depositCents,
    effectiveTotalCents,
    saveCard,
    gcIds,
    gcGans,
    saleMode,
    lineItemUids,
    chunks,
    dayofOrderId: quote.square_dayof_order_id ?? undefined,
  });

  return NextResponse.json({
    ok: true,
    action: "deposit_paid",
    resumed: true,
    giftCardGan: fin.giftCardGan,
    depositCents,
    balanceCents: fin.balanceCents,
  });
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { contractShortId, cardSourceId, giftCardNonce, saveCard } = body as {
    contractShortId: string;
    cardSourceId?: string;
    giftCardNonce?: string;
    saveCard?: boolean;
  };

  if (!contractShortId) {
    return NextResponse.json({ error: "contractShortId required" }, { status: 400 });
  }
  if (!cardSourceId && !giftCardNonce) {
    return NextResponse.json({ error: "cardSourceId or giftCardNonce required" }, { status: 400 });
  }

  const quote = await getGfQuoteByShortId(contractShortId);
  if (!quote) {
    return NextResponse.json({ error: "Quote not found" }, { status: 404 });
  }

  if (quote.deposit_paid_at) {
    return NextResponse.json({
      ok: true,
      action: "already_paid",
      giftCardGan: quote.square_gift_card_gan,
    });
  }

  if (quote.contract_status !== "signed" && quote.status !== "contract_sent") {
    return NextResponse.json(
      { error: `Cannot pay deposit in status: ${quote.status}` },
      { status: 400 },
    );
  }

  const priorDepositCents = computePriorDepositCents(quote);

  if (quote.deposit_due_cents <= 0 && priorDepositCents <= 0) {
    return NextResponse.json({ error: "No deposit due" }, { status: 400 });
  }

  // Stable per-attempt key: a double-click resolves to the SAME Square order +
  // payment (Square dedups on idempotency key), so the guest can't be charged
  // twice. A failed attempt bumps deposit_attempts, unlocking a fresh key.
  const attempt = quote.deposit_attempts || 0;
  const baseKey = `gfd${quote.id}a${attempt}`;

  // ═══ Legacy deposit flow ═══
  // Prior BMI deposit exists — convert to complimentary gift card,
  // charge only the difference (if within 96hr), and save card on file.
  if (priorDepositCents > 0) {
    return handleLegacyDeposit(quote, priorDepositCents, cardSourceId, baseKey);
  }

  // ═══ Resume: a prior attempt captured the charge but died mid-fulfillment ═══
  if (quote.square_deposit_payment_id && !quote.deposit_paid_at) {
    try {
      const resumed = await tryResumeCapturedDeposit(quote, Boolean(saveCard));
      if (resumed) return resumed;
    } catch (err: unknown) {
      // The money is captured — never fall through to a fresh charge here.
      const errMsg = err instanceof Error ? err.message : String(err);
      const errCode = err instanceof SquarePaymentError ? err.code : "UNKNOWN";
      const attempts = await updateGfDepositAttempt(quote.id, `RESUME ${errCode}: ${errMsg}`);
      console.error(`[gf-deposit] resume attempt #${attempts} failed:`, errCode, errMsg);
      auditDepositFailure(quote, {
        code: errCode,
        error: errMsg,
        amountCents: quote.deposit_due_cents,
        attempt: attempts,
        charged: true,
      });
      notifyDispatchError({
        reservationId: quote.bmi_reservation_id,
        centerName: quote.center_name,
        plannerEmail: quote.planner_email ?? undefined,
        error: new Error(
          `Deposit CAPTURED (payment ${quote.square_deposit_payment_id}) for "${quote.event_name}" ` +
            `but resume/fulfillment failed: ${errCode}: ${errMsg}`,
        ),
      }).catch(() => {});
      return NextResponse.json(
        {
          error:
            "Your payment was received, but we hit a snag finishing your booking. " +
            "Please refresh this page in a moment — do not pay again. Our team has been notified.",
          code: "CAPTURED_FINALIZE_FAILED",
        },
        { status: 500 },
      );
    }
  }

  // 1. Create the day-of Square order (OPEN — staff redeems at event). This order
  //    carries the tax (as a service charge), so its total_money is the authoritative
  //    tax-inclusive total — the single source of truth for the deposit.
  const dayof = await createDayofOrder(quote, baseKey);
  const dayofOrderId = dayof?.id;
  const dayofTotalCents = dayof?.totalCents ?? null;

  // Derive the deposit FROM the day-of order total (never a pre-tax/independently
  // computed amount — see lessons.md "deposit must equal the day-of order total").
  // 96h full-payment vs 50% is preserved from dispatch's decision. If the day-of
  // order couldn't be created (best-effort; sync cron backfills later), fall back to
  // the stored value so the deposit charge isn't blocked.
  const isFullPayment = quote.deposit_due_cents >= quote.total_cents;
  const depositCents =
    dayofTotalCents != null
      ? isFullPayment
        ? dayofTotalCents
        : Math.round(dayofTotalCents / 2)
      : quote.deposit_due_cents;
  const effectiveTotalCents = dayofTotalCents ?? quote.total_cents;

  // Displayed-vs-charged guard: the contract showed quote.deposit_due_cents. If the
  // day-of-derived deposit diverges beyond per-line rounding, the contract is stale —
  // hard-fail and alert instead of silently charging a different amount.
  if (
    dayofTotalCents != null &&
    Math.abs(depositCents - quote.deposit_due_cents) > DEPOSIT_MISMATCH_TOLERANCE_CENTS
  ) {
    const attempts = await updateGfDepositAttempt(
      quote.id,
      `DEPOSIT_MISMATCH: displayed=${quote.deposit_due_cents} dayofDerived=${depositCents} orderTotal=${dayofTotalCents}`,
    );
    auditDepositFailure(quote, {
      code: "PRICING_STALE",
      error: `Contract shows $${(quote.deposit_due_cents / 100).toFixed(2)} but day-of order implies $${(depositCents / 100).toFixed(2)}`,
      amountCents: depositCents,
      attempt: attempts,
      charged: false,
    });
    await notifyDispatchError({
      reservationId: quote.bmi_reservation_id,
      centerName: quote.center_name,
      plannerEmail: quote.planner_email ?? undefined,
      error: new Error(
        `Deposit mismatch for "${quote.event_name}": contract shows $${(quote.deposit_due_cents / 100).toFixed(2)} ` +
          `but day-of order total $${(dayofTotalCents / 100).toFixed(2)} implies $${(depositCents / 100).toFixed(2)}. Charge halted.`,
      ),
    }).catch(() => {});
    return NextResponse.json(
      {
        error:
          "This contract's pricing is out of date. Our team has been notified — please try again shortly.",
        code: "PRICING_STALE",
      },
      { status: 409 },
    );
  }

  // 2. Create deposit order.
  //    Gift-card-sale mode (DEPOSIT_GC_SALE_V2): the deposit is sold as
  //    GIFT_CARD line items — one per ≤$2k chunk — so each chunk funds a card
  //    via order_id + line_item_uid and Square books it as a gift-card SALE
  //    (excluded from gross sales → no double-count with the day-of order). The
  //    service charge is NOT broken out here; it's realized on the day-of order
  //    at redemption. Legacy mode keeps the service-charge breakout line for the
  //    portal's Service Charges page.
  const saleMode = giftCardSaleEnabled();
  const serviceChargeCents = serviceChargeCentsFromLineItems(quote.line_items);
  const depositServiceCharge = Math.min(serviceChargeCents, depositCents);
  const chunks = giftCardSaleChunks(depositCents);

  let chargeCaptured = false;
  let capturedPaymentId: string | undefined;

  try {
    const depositLineItems = saleMode
      ? chunks.map((amount) => ({
          name: "Group Event Deposit",
          quantity: "1",
          item_type: "GIFT_CARD" as const,
          base_price_money: { amount, currency: "USD" as const },
        }))
      : buildPaymentLineItems("Group Event Deposit", depositCents, depositServiceCharge);

    const depositOrderRes = await fetch(`${SQUARE_BASE}/orders`, {
      method: "POST",
      headers: sqHeaders(),
      body: JSON.stringify({
        idempotency_key: `gf-dep-order-${baseKey}`,
        order: {
          location_id: quote.square_location_id,
          reference_id: `GF Deposit: ${quote.event_number || ""}`.slice(0, 40),
          line_items: depositLineItems,
        },
      }),
    });
    const depositOrderData = await depositOrderRes.json();
    if (!depositOrderRes.ok || !depositOrderData.order?.id) {
      throw new Error(`Deposit order failed: ${JSON.stringify(depositOrderData).slice(0, 300)}`);
    }
    const depositOrderId = depositOrderData.order.id as string;
    // In sale mode the Nth GIFT_CARD line item's uid funds the Nth chunk's card.
    const lineItemUids: string[] = saleMode
      ? ((depositOrderData.order.line_items ?? []) as Array<{ uid?: string }>).map(
          (li) => li.uid ?? "",
        )
      : [];
    if (saleMode && lineItemUids.filter(Boolean).length !== chunks.length) {
      throw new Error(
        `Deposit order returned ${lineItemUids.filter(Boolean).length} line uids, expected ${chunks.length}`,
      );
    }

    // 3. PRE-CHARGE: create (not activate) one DIGITAL gift card per ≤$2k chunk.
    //    A failure here — including the GAN-collision that used to brick retries —
    //    happens before any money moves.
    const { gcIds, gcGans } = await ensureDepositGiftCards(quote, chunks, baseKey);

    // 4. Charge via multi-tender (gift card partial + card remainder)
    const multiTender = await authorizeMultiTender({
      orderId: depositOrderId,
      locationId: quote.square_location_id,
      totalCents: depositCents,
      baseKey,
      giftCardNonce: giftCardNonce || undefined,
      cardSourceId: cardSourceId || undefined,
      note: `GF Deposit: ${quote.event_name || ""}`,
    });

    const depositPaymentId = (multiTender.cardPaymentId || multiTender.gcPaymentId) as string;
    chargeCaptured = true;
    capturedPaymentId = depositPaymentId;

    // 5. Persist-first: the charge is captured — record it BEFORE fulfillment so
    //    any later failure resumes from this payment instead of charging again.
    await updateGfDepositChargeCaptured(quote.id, {
      square_deposit_order_id: depositOrderId,
      square_deposit_payment_id: depositPaymentId,
      square_gift_card_id: JSON.stringify(gcIds),
      square_gift_card_gan: JSON.stringify(gcGans),
      square_dayof_order_id: dayofOrderId ?? null,
    });

    const paymentIds = [multiTender.gcPaymentId, multiTender.cardPaymentId].filter(
      (id): id is string => Boolean(id),
    );

    // 6. Activate cards, save card on file, mark paid, notify.
    const fin = await finalizeDeposit({
      quote,
      depositOrderId,
      depositPaymentId,
      cardPaymentId: multiTender.cardPaymentId,
      paymentIds,
      depositCents,
      effectiveTotalCents,
      saveCard: Boolean(saveCard),
      gcIds,
      gcGans,
      saleMode,
      lineItemUids,
      chunks,
      dayofOrderId,
    });

    return NextResponse.json({
      ok: true,
      action: "deposit_paid",
      giftCardGan: fin.giftCardGan,
      depositCents,
      balanceCents: fin.balanceCents,
    });
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    const errCode = err instanceof SquarePaymentError ? err.code : "UNKNOWN";

    // Track failed attempt
    const attempts = await updateGfDepositAttempt(quote.id, `${errCode}: ${errMsg}`);
    console.error(`[gf-deposit] attempt #${attempts} failed:`, errCode, errMsg);
    auditDepositFailure(quote, {
      code: errCode,
      error: errMsg,
      amountCents: depositCents,
      attempt: attempts,
      charged: chargeCaptured,
    });

    if (chargeCaptured) {
      // Money captured, fulfillment failed. The next attempt resumes from the
      // persisted payment — but be explicit so the guest doesn't panic-retry.
      notifyDispatchError({
        reservationId: quote.bmi_reservation_id,
        centerName: quote.center_name,
        plannerEmail: quote.planner_email ?? undefined,
        error: new Error(
          `Deposit CAPTURED (payment ${capturedPaymentId}) for "${quote.event_name}" but fulfillment failed: ${errCode}: ${errMsg}`,
        ),
      }).catch(() => {});
      return NextResponse.json(
        {
          error:
            "Your payment was received, but we hit a snag finishing your booking. " +
            "Please refresh this page in a moment — do not pay again. Our team has been notified.",
          code: "CAPTURED_FINALIZE_FAILED",
        },
        { status: 500 },
      );
    }

    if (err instanceof SquarePaymentError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: 402 });
    }
    return NextResponse.json(
      { error: "Payment processing failed. Please try again." },
      { status: 500 },
    );
  }
}

async function handleLegacyDeposit(
  quote: GroupFunctionQuote,
  priorDepositCents: number,
  cardSourceId: string | undefined,
  baseKey: string,
): Promise<NextResponse> {
  if (!cardSourceId) {
    return NextResponse.json({ error: "Card is required" }, { status: 400 });
  }

  const isFullPayment = quote.balance_cents === 0;

  let chargeCaptured = false;
  let capturedPaymentId: string | undefined;
  let chargeCents = 0;

  try {
    // 1. Create day-of Square order — try catalog IDs first, fall back to ad-hoc.
    //    Its total_money (tax-inclusive) is the authoritative event total.
    const dayof = await createDayofOrder(quote, baseKey);
    const dayofOrderId = dayof?.id;
    const effectiveTotalCents = dayof?.totalCents ?? quote.total_cents;

    // Full payment charges the remaining event total (less the prior BMI deposit),
    // derived from the day-of order total so it can't diverge from what staff redeem.
    chargeCents = isFullPayment ? Math.max(0, effectiveTotalCents - priorDepositCents) : 0;

    // 2. Find/create Square customer
    let squareCustomerId: string | undefined;
    try {
      squareCustomerId = (await findOrCreateSquareCustomer(quote)) ?? undefined;
    } catch (err) {
      console.error("[gf-deposit-legacy] customer lookup/create error:", err);
    }

    // 3. Complimentary gift cards for the prior deposit — one per ≤$2k chunk.
    //    (Was: a single card, which blew Square's $2k/card cap for any prior
    //    deposit over $2,000 — the PAYMENT_LIMIT_EXCEEDED / "gift card exceeded
    //    value" failure, event #3098.) Cards persist BEFORE the charge so a
    //    retry reuses them instead of minting duplicate live-value comps.
    const compChunks = giftCardSaleChunks(priorDepositCents);
    let compIds = parseGiftCardIds(quote.square_gift_card_id);
    let compGans = parseGiftCardGans(quote.square_gift_card_gan);
    const preexisting = compIds.length;
    for (let i = compIds.length; i < compChunks.length; i++) {
      const compGc = await mintDigitalGiftCard({
        locationId: quote.square_location_id,
        amountCents: compChunks[i],
        baseKey: `${baseKey}-comp-${i}`,
        discountCatalogObjectId: LEGACY_DEPOSIT_DISCOUNT_ID,
        customerId: squareCustomerId,
      });
      compIds.push(compGc.giftCardId);
      compGans.push(compGc.gan);
      console.log(
        `[gf-deposit-legacy] complimentary GC ${i + 1}/${compChunks.length}: ${compGc.gan} ` +
          `$${(compChunks[i] / 100).toFixed(2)}`,
      );
      await updateGfGiftCardList(quote.id, { giftCardIds: compIds, giftCardGans: compGans });
    }
    if (preexisting > 0) {
      console.log(
        `[gf-deposit-legacy] reusing ${preexisting} comp gift card(s) from a prior attempt`,
      );
    }

    // 4. Charge the card if needed (96hr case) and LOAD the GCs
    let depositOrderId: string | undefined;
    let depositPaymentId: string | undefined;
    let resumedPayment = false;

    if (chargeCents > 0) {
      // Resume: a prior attempt's charge captured but fulfillment failed.
      const persisted = quote.square_deposit_payment_id;
      if (persisted && !persisted.startsWith("legacy-comp-")) {
        const payment = await getCompletedPayment(persisted);
        if (payment) {
          depositPaymentId = payment.id;
          depositOrderId = quote.square_deposit_order_id || payment.orderId;
          resumedPayment = true;
          chargeCaptured = true;
          capturedPaymentId = payment.id;
          console.log(
            `[gf-deposit-legacy] RESUME quote=${quote.id} payment=${persisted} — skipping charge`,
          );
        }
      }

      if (!depositPaymentId) {
        // Create deposit order for the charge amount
        const legacyServiceCharge = Math.min(
          serviceChargeCentsFromLineItems(quote.line_items),
          chargeCents,
        );
        const depOrderRes = await fetch(`${SQUARE_BASE}/orders`, {
          method: "POST",
          headers: sqHeaders(),
          body: JSON.stringify({
            idempotency_key: `gf-dep-order-${baseKey}`,
            order: {
              location_id: quote.square_location_id,
              reference_id: `GF Deposit: ${quote.event_number || ""}`.slice(0, 40),
              line_items: buildPaymentLineItems(
                "Group Event Balance (Legacy Deposit Applied)",
                chargeCents,
                legacyServiceCharge,
              ),
            },
          }),
        });
        const depOrderData = await depOrderRes.json();
        if (!depOrderRes.ok || !depOrderData.order?.id) {
          throw new Error(`Deposit order failed: ${JSON.stringify(depOrderData).slice(0, 300)}`);
        }
        depositOrderId = depOrderData.order.id as string;

        const multiTender = await authorizeMultiTender({
          orderId: depositOrderId,
          locationId: quote.square_location_id,
          totalCents: chargeCents,
          baseKey,
          cardSourceId,
          note: `GF Balance: ${quote.event_name || ""} (legacy deposit applied)`,
        });
        depositPaymentId = (multiTender.cardPaymentId || multiTender.gcPaymentId) as string;
        chargeCaptured = true;
        capturedPaymentId = depositPaymentId;

        // Persist-first: retries resume from this payment, never re-charge.
        await updateGfDepositChargeCaptured(quote.id, {
          square_deposit_order_id: depositOrderId,
          square_deposit_payment_id: depositPaymentId,
          square_dayof_order_id: dayofOrderId ?? null,
        });
      }

      // LOAD the charged amount onto the comp cards — cap-aware ($2k/card,
      // overflow mints new cards) and resume-idempotent: only the portion this
      // payment hasn't already loaded goes on.
      const alreadyLoaded = resumedPayment
        ? await sumGiftCardLoadsForPayment({ giftCardIds: compIds, paymentId: depositPaymentId })
        : 0;
      const remainingToLoad = Math.max(0, chargeCents - alreadyLoaded);
      if (remainingToLoad > 0) {
        const loaded = await loadBalanceOntoGiftCards({
          giftCardIds: compIds,
          locationId: quote.square_location_id,
          amountCents: remainingToLoad,
          baseKey: `${baseKey}-load`,
          buyerPaymentInstrumentIds: [depositPaymentId],
        });
        if (loaded.createdCards.length) {
          compIds = loaded.giftCardIds;
          compGans = [...compGans, ...loaded.createdCards.map((c) => c.gan ?? "")];
        }
      }

      console.log(
        `[gf-deposit-legacy] charged $${(chargeCents / 100).toFixed(2)} ` +
          `(loaded $${(remainingToLoad / 100).toFixed(2)} onto ${compIds.length} card(s))`,
      );
    }

    // 5. Save card on file
    let savedCardId: string | undefined;
    let savedCardLast4: string | undefined;
    let savedCardBrand: string | undefined;

    if (depositPaymentId && squareCustomerId) {
      // Card was charged — save from payment ID
      try {
        const cardRes = await fetch(`${SQUARE_BASE}/cards`, {
          method: "POST",
          headers: sqHeaders(),
          body: JSON.stringify({
            idempotency_key: `gfcard-${depositPaymentId}`,
            source_id: depositPaymentId,
            card: { customer_id: squareCustomerId },
          }),
        });
        const cardData = await cardRes.json();
        if (cardRes.ok && cardData.card?.id) {
          savedCardId = cardData.card.id;
          savedCardLast4 = cardData.card.last_4 || undefined;
          savedCardBrand = cardData.card.card_brand || undefined;
        } else {
          console.error("[gf-deposit-legacy] card save from payment failed:", cardData);
        }
      } catch (err) {
        console.error("[gf-deposit-legacy] card save error:", err);
      }
    } else if (squareCustomerId) {
      // No charge — save card from nonce via verify + save pattern
      try {
        const verifyRes = await fetch(`${SQUARE_BASE}/payments`, {
          method: "POST",
          headers: sqHeaders(),
          body: JSON.stringify({
            idempotency_key: `gf-verify-${baseKey}`,
            source_id: cardSourceId,
            amount_money: { amount: 0, currency: "USD" },
            location_id: quote.square_location_id,
            autocomplete: false,
          }),
        });
        const verifyData = await verifyRes.json();
        const verifyPaymentId = verifyData.payment?.id;

        if (verifyPaymentId) {
          // Cancel the $0 auth
          await fetch(`${SQUARE_BASE}/payments/${verifyPaymentId}/cancel`, {
            method: "POST",
            headers: sqHeaders(),
          });
        }

        // Save from nonce
        const cardRes = await fetch(`${SQUARE_BASE}/cards`, {
          method: "POST",
          headers: sqHeaders(),
          body: JSON.stringify({
            idempotency_key: `gf-card-${baseKey}`,
            source_id: cardSourceId,
            card: { customer_id: squareCustomerId },
          }),
        });
        const cardData = await cardRes.json();
        if (cardRes.ok && cardData.card?.id) {
          savedCardId = cardData.card.id;
          savedCardLast4 = cardData.card.last_4 || undefined;
          savedCardBrand = cardData.card.card_brand || undefined;
          console.log(`[gf-deposit-legacy] card saved (no charge): ${savedCardId}`);
        } else {
          console.error("[gf-deposit-legacy] card save from nonce failed:", cardData);
        }
      } catch (err) {
        console.error("[gf-deposit-legacy] card verify/save error:", err);
      }
    }

    const gcIds = JSON.stringify(compIds);
    const gcGans = JSON.stringify(compGans);
    const totalDeposited = priorDepositCents + chargeCents;
    const balanceCents = Math.max(0, effectiveTotalCents - totalDeposited);

    // 6. Update Neon
    await updateGfDepositPaid(quote.id, {
      square_deposit_order_id: depositOrderId || `legacy-comp-${baseKey}`,
      square_deposit_payment_id: depositPaymentId || `legacy-comp-${baseKey}`,
      square_gift_card_id: gcIds,
      square_gift_card_gan: gcGans,
      square_customer_id: squareCustomerId,
      saved_card_id: savedCardId,
      square_dayof_order_id: dayofOrderId,
      deposit_paid_at: new Date().toISOString(),
      balance_cents: balanceCents,
    });

    // Also update deposit_due_cents + card display info
    const { sql } = await import("@/lib/db");
    const q = sql();
    await q`UPDATE group_function_quotes SET
      deposit_due_cents = ${totalDeposited},
      saved_card_last4 = ${savedCardLast4 ?? null},
      saved_card_brand = ${savedCardBrand ?? null}
    WHERE id = ${quote.id}`;

    // 7. Notify + BMI Office notes
    const updatedQuote = await getGfQuoteByShortId(quote.contract_short_id!);
    if (updatedQuote) {
      if (updatedQuote.is_winback) {
        // Win-back: the guest just put a card on file — issue the $20 now and
        // send the win-back receipt (mentions the $20 + the 72h charge schedule).
        // The standard 72h balance cron will charge the saved card. A mint
        // failure here is retried by the reconcile cron's incentive sweep.
        const { issueWinbackIncentive } = await import("@/lib/group-function-winback");
        issueWinbackIncentive(updatedQuote).catch((err) =>
          console.error("[gf-deposit-legacy] winback incentive error:", err),
        );
      } else {
        notifyDepositPaid(updatedQuote).catch((err) =>
          console.error("[gf-deposit-legacy] notify error:", err),
        );
      }
    }

    // Confirm BMI + record the charged amount (if any) + note. Best-effort AFTER
    // capture — a BMI failure must not read as a payment failure to the guest.
    try {
      const { confirmAndRecordBmiPayment } = await import("@/lib/bmi-office-actions");
      const legacyNote =
        `Legacy deposit: $${(priorDepositCents / 100).toFixed(2)} → GC ${compGans.join(", ")}` +
        (chargeCents > 0 ? ` + charged $${(chargeCents / 100).toFixed(2)}` : "") +
        ` | Balance: $${(balanceCents / 100).toFixed(2)}`;
      await confirmAndRecordBmiPayment({
        centerCode: quote.center_code,
        projectId: quote.bmi_reservation_id,
        lineItems: (quote.line_items || []) as Array<{ name: string }>,
        amountDollars: chargeCents / 100,
        note: legacyNote,
        contractUrl: `${quote.base_url || "https://fasttraxent.com"}/contract/${quote.contract_short_id}`,
      });
    } catch (err) {
      console.error("[gf-deposit-legacy] BMI confirm/record failed (payment captured):", err);
      notifyDispatchError({
        reservationId: quote.bmi_reservation_id,
        centerName: quote.center_name,
        plannerEmail: quote.planner_email ?? undefined,
        error: new Error(
          `Legacy deposit applied for "${quote.event_name}" but BMI confirm/record failed: ${err instanceof Error ? err.message : String(err)}`,
        ),
      }).catch(() => {});
    }

    firePortalWebhookAsync("payment.deposit_paid", {
      documentId: quote.contract_short_id,
      bmiCode: quote.bmi_reservation_id,
      venue: quote.center_code,
      status: "deposit_paid",
    });

    // Generate signed PDF server-side (non-fatal to deposit)
    try {
      const { generateAndStorePdf } = await import("@/lib/contract-pdf-generate");
      await generateAndStorePdf(quote.contract_short_id!);
    } catch (err) {
      console.error("[gf-deposit-legacy] PDF generation failed:", err);
    }

    return NextResponse.json({
      ok: true,
      action: "legacy_deposit_applied",
      giftCardGan: gcGans,
      priorDepositCents,
      chargeCents,
      balanceCents,
    });
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    const errCode = err instanceof SquarePaymentError ? err.code : "UNKNOWN";
    const attempts = await updateGfDepositAttempt(quote.id, `${errCode}: ${errMsg}`);
    console.error(`[gf-deposit-legacy] attempt #${attempts} failed:`, errCode, errMsg);
    auditDepositFailure(quote, {
      code: errCode,
      error: errMsg,
      amountCents: chargeCents || priorDepositCents,
      attempt: attempts,
      charged: chargeCaptured,
    });

    if (chargeCaptured) {
      notifyDispatchError({
        reservationId: quote.bmi_reservation_id,
        centerName: quote.center_name,
        plannerEmail: quote.planner_email ?? undefined,
        error: new Error(
          `Legacy deposit charge CAPTURED (payment ${capturedPaymentId}) for "${quote.event_name}" but fulfillment failed: ${errCode}: ${errMsg}`,
        ),
      }).catch(() => {});
      return NextResponse.json(
        {
          error:
            "Your payment was received, but we hit a snag finishing your booking. " +
            "Please refresh this page in a moment — do not pay again. Our team has been notified.",
          code: "CAPTURED_FINALIZE_FAILED",
        },
        { status: 500 },
      );
    }

    if (err instanceof SquarePaymentError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: 402 });
    }
    return NextResponse.json(
      { error: "Payment processing failed. Please try again." },
      { status: 500 },
    );
  }
}

// findOrCreateSquareCustomer moved to @/lib/square-gift-card (shared with the reprice flow).
// createDayofOrder moved to @/lib/group-function-dayof (shared with the group-quote-sync
// self-heal backfill so a deposit-time failure is retried instead of orphaning the event).
