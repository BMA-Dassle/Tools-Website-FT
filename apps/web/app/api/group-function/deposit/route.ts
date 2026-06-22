import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { buildGanPrefix } from "@/lib/gan";
import {
  getGfQuoteByShortId,
  updateGfDepositPaid,
  updateGfDepositAttempt,
  type GroupFunctionQuote,
} from "@/lib/group-function-db";
import { notifyDepositPaid } from "@/lib/group-function-notify";
import {
  authorizeMultiTender,
  mintDigitalGiftCard,
  loadGiftCard,
  findOrCreateSquareCustomer,
  SquarePaymentError,
} from "@/lib/square-gift-card";
import { createDayofOrder } from "@/lib/group-function-dayof";
import { giftCardSaleEnabled, giftCardSaleChunks } from "~/features/booking/service/deposit";
import { serviceChargeCentsFromLineItems, buildPaymentLineItems } from "@/lib/service-charge";
import { firePortalWebhookAsync } from "@/lib/portal-webhook";
import { notifyDispatchError } from "@/lib/group-function-alert";

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

  const baseKey = randomBytes(8).toString("hex");

  // ═══ Legacy deposit flow ═══
  // Prior BMI deposit exists — convert to complimentary gift card,
  // charge only the difference (if within 96hr), and save card on file.
  if (priorDepositCents > 0) {
    return handleLegacyDeposit(quote, priorDepositCents, cardSourceId, baseKey);
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
    await updateGfDepositAttempt(
      quote.id,
      `DEPOSIT_MISMATCH: displayed=${quote.deposit_due_cents} dayofDerived=${depositCents} orderTotal=${dayofTotalCents}`,
    );
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
  const ganSuffix = quote.bmi_reservation_id.slice(-8);
  const serviceChargeCents = serviceChargeCentsFromLineItems(quote.line_items);
  const depositServiceCharge = Math.min(serviceChargeCents, depositCents);
  const chunks = giftCardSaleChunks(depositCents);

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

    // 3. Charge via multi-tender (gift card partial + card remainder)
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

    // 4. Create + activate one DIGITAL gift card per ≤$2k chunk.
    // Persisted prefix (set at quote insert) wins; fall back to the current
    // channel+center scheme for legacy rows that predate the gan_prefix column.
    const prefix = quote.gan_prefix || buildGanPrefix("GF", quote.square_location_id);
    const baseGan = `${prefix}${ganSuffix}`.replace(/[^A-Za-z0-9]/g, "");
    const paymentIds = [multiTender.gcPaymentId, multiTender.cardPaymentId].filter(
      (id): id is string => Boolean(id),
    );

    const gcIds: string[] = [];
    const gcGans: string[] = [];

    for (let gcIndex = 0; gcIndex < chunks.length; gcIndex++) {
      const chunkCents = chunks[gcIndex];
      const suffix = gcIndex === 0 ? "" : String.fromCharCode(65 + gcIndex); // "", "B", "C", ...
      const customGan = `${baseGan}${suffix}`;
      const useCustomGan = customGan.length >= 8 && customGan.length <= 20;

      const gcRes = await fetch(`${SQUARE_BASE}/gift-cards`, {
        method: "POST",
        headers: sqHeaders(),
        body: JSON.stringify({
          idempotency_key: `gf-gc-${baseKey}-${gcIndex}`,
          location_id: quote.square_location_id,
          gift_card: {
            type: "DIGITAL",
            ...(useCustomGan ? { gan_source: "OTHER", gan: customGan } : {}),
          },
        }),
      });
      const gcData = await gcRes.json();
      if (!gcRes.ok || !gcData.gift_card?.id) {
        throw new Error(
          `Gift card #${gcIndex} creation failed: ${JSON.stringify(gcData).slice(0, 300)}`,
        );
      }

      const gcId = gcData.gift_card.id as string;
      const gcGan = gcData.gift_card.gan as string;

      // 5. Activate. Sale mode links to the chunk's GIFT_CARD line item (Square
      //    reads the load amount from it → booked as a gift-card sale); legacy
      //    mode passes the amount + funding instruments. Mutually exclusive
      //    forms — Square rejects a request carrying both. Activation failure is
      //    logged, not thrown: the deposit is already captured and baseKey is
      //    per-request, so throwing here would risk a double charge on retry.
      const actRes = await fetch(`${SQUARE_BASE}/gift-cards/activities`, {
        method: "POST",
        headers: sqHeaders(),
        body: JSON.stringify({
          idempotency_key: `gf-gc-act-${baseKey}-${gcIndex}`,
          gift_card_activity: {
            type: "ACTIVATE",
            location_id: quote.square_location_id,
            gift_card_id: gcId,
            activate_activity_details: saleMode
              ? { order_id: depositOrderId, line_item_uid: lineItemUids[gcIndex] }
              : {
                  amount_money: { amount: chunkCents, currency: "USD" },
                  buyer_payment_instrument_ids: paymentIds,
                },
          },
        }),
      });
      const actData = await actRes.json();
      if (!actRes.ok || actData.errors) {
        console.error(`[gf-deposit] gift card #${gcIndex} activation failed:`, actData);
      }

      gcIds.push(gcId);
      gcGans.push(gcGan);

      console.log(
        `[gf-deposit] gift card #${gcIndex + 1}/${chunks.length}: ${gcGan} ` +
          `activated $${(chunkCents / 100).toFixed(2)} (saleMode=${saleMode})`,
      );
    }

    const giftCardId = JSON.stringify(gcIds);
    const giftCardGan = JSON.stringify(gcGans);

    // 6. Save card on file for 72-hour auto-charge
    // Square requires: charge first → use the paymentId as source_id for CreateCard.
    // The nonce is consumed by the payment; the paymentId is the handle to save from.
    // See: https://developer.squareup.com/docs/cards-api/walkthrough/card-from-payment-id
    let savedCardId: string | undefined;
    let savedCardLast4: string | undefined;
    let savedCardBrand: string | undefined;

    const custResult = await findOrCreateSquareCustomer(quote);
    const squareCustomerId = custResult ?? undefined;

    if (saveCard && multiTender.cardPaymentId && squareCustomerId) {
      const cardRes = await fetch(`${SQUARE_BASE}/cards`, {
        method: "POST",
        headers: sqHeaders(),
        body: JSON.stringify({
          idempotency_key: `gf-card-${baseKey}`,
          source_id: multiTender.cardPaymentId,
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
    }

    // 7. Update Neon
    await updateGfDepositPaid(quote.id, {
      square_deposit_order_id: depositOrderId,
      square_deposit_payment_id: depositPaymentId,
      square_gift_card_id: giftCardId,
      square_gift_card_gan: giftCardGan,
      square_customer_id: squareCustomerId,
      saved_card_id: savedCardId,
      square_dayof_order_id: dayofOrderId,
      deposit_paid_at: new Date().toISOString(),
      balance_cents: effectiveTotalCents - depositCents,
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

    // Single point: confirm BMI + record the deposit payment + note.
    const { confirmAndRecordBmiPayment } = await import("@/lib/bmi-office-actions");
    await confirmAndRecordBmiPayment({
      centerCode: quote.center_code,
      projectId: quote.bmi_reservation_id,
      lineItems: (quote.line_items || []) as Array<{ name: string }>,
      amountDollars: depositCents / 100,
      note: `Deposit paid: $${(depositCents / 100).toFixed(2)} | GAN: ${giftCardGan} | Balance: $${((effectiveTotalCents - depositCents) / 100).toFixed(2)}`,
      contractUrl: `${quote.base_url || "https://fasttraxent.com"}/contract/${quote.contract_short_id}`,
    });

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

    return NextResponse.json({
      ok: true,
      action: "deposit_paid",
      giftCardGan,
      depositCents,
      balanceCents: effectiveTotalCents - depositCents,
    });
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    const errCode = err instanceof SquarePaymentError ? err.code : "UNKNOWN";

    // Track failed attempt
    const attempts = await updateGfDepositAttempt(quote.id, `${errCode}: ${errMsg}`);
    console.error(`[gf-deposit] attempt #${attempts} failed:`, errCode, errMsg);

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

  try {
    // 1. Create day-of Square order — try catalog IDs first, fall back to ad-hoc.
    //    Its total_money (tax-inclusive) is the authoritative event total.
    const dayof = await createDayofOrder(quote, baseKey);
    const dayofOrderId = dayof?.id;
    const effectiveTotalCents = dayof?.totalCents ?? quote.total_cents;

    // Full payment charges the remaining event total (less the prior BMI deposit),
    // derived from the day-of order total so it can't diverge from what staff redeem.
    const chargeCents = isFullPayment ? Math.max(0, effectiveTotalCents - priorDepositCents) : 0;

    // 2. Find/create Square customer
    const custResult = await findOrCreateSquareCustomer(quote);
    const squareCustomerId = custResult ?? undefined;

    // 3. Create complimentary gift card for the prior deposit amount
    const compGc = await mintDigitalGiftCard({
      locationId: quote.square_location_id,
      amountCents: priorDepositCents,
      baseKey: `${baseKey}-comp`,
      discountCatalogObjectId: LEGACY_DEPOSIT_DISCOUNT_ID,
      customerId: squareCustomerId,
    });

    console.log(
      `[gf-deposit-legacy] complimentary GC: ${compGc.gan} $${(priorDepositCents / 100).toFixed(2)}`,
    );

    // 4. Charge the card if needed (96hr case) and LOAD the GC
    let depositOrderId: string | undefined;
    let depositPaymentId: string | undefined;

    if (chargeCents > 0) {
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

      // LOAD the complimentary gift card with the charged amount
      await loadGiftCard({
        giftCardId: compGc.giftCardId,
        locationId: quote.square_location_id,
        amountCents: chargeCents,
        baseKey: `${baseKey}-load`,
        buyerPaymentInstrumentIds: depositPaymentId ? [depositPaymentId] : [],
      });

      console.log(
        `[gf-deposit-legacy] charged $${(chargeCents / 100).toFixed(2)}, loaded onto GC ${compGc.gan}`,
      );
    }

    // 5. Save card on file
    let savedCardId: string | undefined;
    let savedCardLast4: string | undefined;
    let savedCardBrand: string | undefined;

    if (depositPaymentId && squareCustomerId) {
      // Card was charged — save from payment ID
      const cardRes = await fetch(`${SQUARE_BASE}/cards`, {
        method: "POST",
        headers: sqHeaders(),
        body: JSON.stringify({
          idempotency_key: `gf-card-${baseKey}`,
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

    const gcIds = JSON.stringify([compGc.giftCardId]);
    const gcGans = JSON.stringify([compGc.gan]);
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

    // Single point: confirm BMI + record the charged amount (if any) + note.
    const { confirmAndRecordBmiPayment } = await import("@/lib/bmi-office-actions");
    const legacyNote =
      `Legacy deposit: $${(priorDepositCents / 100).toFixed(2)} → GC ${compGc.gan}` +
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
