import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "crypto";
import {
  getGfQuoteByShortId,
  updateGfDepositPaid,
  updateGfDepositAttempt,
  type GroupFunctionQuote,
} from "@/lib/group-function-db";
import { notifyDepositPaid } from "@/lib/group-function-notify";
import { authorizeMultiTender, SquarePaymentError } from "@/lib/square-gift-card";
import { buildSquareLineItem } from "@/lib/plu-catalog-map";

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

  if (quote.deposit_due_cents <= 0) {
    return NextResponse.json({ error: "No deposit due" }, { status: 400 });
  }

  const baseKey = randomBytes(8).toString("hex");

  // 1. Create the day-of Square order (OPEN — staff redeems at event)
  let dayofOrderId: string | undefined;
  try {
    const lineItems = (
      quote.line_items as Array<{
        name: string;
        price: number;
        tax: number;
        qty: number;
        total: number;
        plu: string;
      }>
    ).map((p) => buildSquareLineItem(quote.center_code, p));

    const serviceCharges = quote.tax_cents > 0
      ? [{
          name: "Service Charge",
          amount_money: { amount: quote.tax_cents, currency: "USD" },
          calculation_phase: "SUBTOTAL_PHASE",
        }]
      : [];

    const orderRes = await fetch(`${SQUARE_BASE}/orders`, {
      method: "POST",
      headers: sqHeaders(),
      body: JSON.stringify({
        idempotency_key: `gf-dayof-${baseKey}`,
        order: {
          location_id: quote.square_location_id,
          reference_id: `GF-${quote.event_number || quote.bmi_reservation_id}`.slice(0, 40),
          line_items: lineItems,
          service_charges: serviceCharges.length > 0 ? serviceCharges : undefined,
        },
      }),
    });
    const orderData = await orderRes.json();
    if (orderRes.ok && orderData.order?.id) {
      dayofOrderId = orderData.order.id;
    } else {
      console.error("[gf-deposit] day-of order creation failed:", orderData);
    }
  } catch (err: unknown) {
    console.error("[gf-deposit] day-of order error:", err);
  }

  // 2. Create deposit order (single line, no tax — fraction of tax-inclusive total)
  const ganSuffix = quote.bmi_reservation_id.slice(-8);

  try {
    const depositOrderRes = await fetch(`${SQUARE_BASE}/orders`, {
      method: "POST",
      headers: sqHeaders(),
      body: JSON.stringify({
        idempotency_key: `gf-dep-order-${baseKey}`,
        order: {
          location_id: quote.square_location_id,
          reference_id: `GF Deposit: ${quote.event_number || ""}`.slice(0, 40),
          line_items: [
            {
              name: "Group Event Deposit",
              quantity: "1",
              base_price_money: { amount: quote.deposit_due_cents, currency: "USD" },
            },
          ],
        },
      }),
    });
    const depositOrderData = await depositOrderRes.json();
    if (!depositOrderRes.ok || !depositOrderData.order?.id) {
      throw new Error(`Deposit order failed: ${JSON.stringify(depositOrderData).slice(0, 300)}`);
    }
    const depositOrderId = depositOrderData.order.id as string;

    // 3. Charge via multi-tender (gift card partial + card remainder)
    const multiTender = await authorizeMultiTender({
      orderId: depositOrderId,
      locationId: quote.square_location_id,
      totalCents: quote.deposit_due_cents,
      baseKey,
      giftCardNonce: giftCardNonce || undefined,
      cardSourceId: cardSourceId || undefined,
      note: `GF Deposit: ${quote.event_name || ""}`,
    });

    const depositPaymentId = (multiTender.cardPaymentId || multiTender.gcPaymentId) as string;

    // 4. Create DIGITAL gift cards in $2k chunks (Square max per card)
    const GC_MAX_CENTS = 200_000;
    const prefix = quote.gan_prefix || "GRPF";
    const baseGan = `${prefix}${ganSuffix}`.replace(/[^A-Za-z0-9]/g, "");
    const paymentIds = [multiTender.gcPaymentId, multiTender.cardPaymentId].filter(
      (id): id is string => Boolean(id),
    );

    const gcIds: string[] = [];
    const gcGans: string[] = [];
    let depositRemaining = quote.deposit_due_cents;
    let gcIndex = 0;

    while (depositRemaining > 0) {
      const chunkCents = Math.min(depositRemaining, GC_MAX_CENTS);
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
        throw new Error(`Gift card #${gcIndex} creation failed: ${JSON.stringify(gcData).slice(0, 300)}`);
      }

      const gcId = gcData.gift_card.id as string;
      const gcGan = gcData.gift_card.gan as string;

      // 5. Activate with chunk amount (unlinked — no customer_id)
      const actRes = await fetch(`${SQUARE_BASE}/gift-cards/activities`, {
        method: "POST",
        headers: sqHeaders(),
        body: JSON.stringify({
          idempotency_key: `gf-gc-act-${baseKey}-${gcIndex}`,
          gift_card_activity: {
            type: "ACTIVATE",
            location_id: quote.square_location_id,
            gift_card_id: gcId,
            activate_activity_details: {
              amount_money: { amount: chunkCents, currency: "USD" },
              buyer_payment_instrument_ids: paymentIds,
            },
          },
        }),
      });
      const actData = await actRes.json();
      if (!actRes.ok) {
        console.error(`[gf-deposit] gift card #${gcIndex} activation failed:`, actData);
      }

      gcIds.push(gcId);
      gcGans.push(gcGan);
      depositRemaining -= chunkCents;
      gcIndex++;

      console.log(`[gf-deposit] gift card #${gcIndex}: ${gcGan} activated with $${(chunkCents / 100).toFixed(2)}`);
    }

    const giftCardId = JSON.stringify(gcIds);
    const giftCardGan = JSON.stringify(gcGans);

    // 6. Save card on file for 72-hour auto-charge
    // Square requires: charge first → use the paymentId as source_id for CreateCard.
    // The nonce is consumed by the payment; the paymentId is the handle to save from.
    // See: https://developer.squareup.com/docs/cards-api/walkthrough/card-from-payment-id
    let savedCardId: string | undefined;
    let squareCustomerId: string | undefined;

    const custResult = await findOrCreateSquareCustomer(quote);
    squareCustomerId = custResult ?? undefined;

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
        console.log(`[gf-deposit] card saved: ${savedCardId} for customer ${squareCustomerId}`);
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
      balance_cents: quote.total_cents - quote.deposit_due_cents,
    });

    // Notify guest + planner (non-blocking)
    const updatedQuote = await getGfQuoteByShortId(quote.contract_short_id!);
    if (updatedQuote) {
      notifyDepositPaid(updatedQuote).catch((err) =>
        console.error("[gf-deposit] notify error:", err),
      );
    }

    // Update BMI Office: status + record payment (must complete before response)
    try {
      const { updateProjectStatus, recordProjectPayment, hasWaiverRequiredActivities } =
        await import("@/lib/bmi-office-actions");
      const items = (quote.line_items || []) as Array<{ name: string }>;
      await updateProjectStatus({
        centerCode: quote.center_code,
        projectId: quote.bmi_reservation_id,
        hasWaiverActivities: hasWaiverRequiredActivities(items),
      });
      await recordProjectPayment({
        centerCode: quote.center_code,
        projectId: quote.bmi_reservation_id,
        amountDollars: quote.deposit_due_cents / 100,
      });
    } catch (err) {
      console.error("[gf-deposit] BMI Office update error:", err);
    }

    return NextResponse.json({
      ok: true,
      action: "deposit_paid",
      giftCardGan,
      depositCents: quote.deposit_due_cents,
      balanceCents: quote.total_cents - quote.deposit_due_cents,
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

async function findOrCreateSquareCustomer(quote: {
  guest_email: string;
  guest_first_name: string;
  guest_last_name: string;
  guest_phone: string | null;
  square_location_id: string;
}): Promise<string | null> {
  // Search by email
  const searchRes = await fetch(`${SQUARE_BASE}/customers/search`, {
    method: "POST",
    headers: sqHeaders(),
    body: JSON.stringify({
      query: {
        filter: {
          email_address: { exact: quote.guest_email },
        },
      },
      limit: 1,
    }),
  });
  const searchData = await searchRes.json();
  if (searchRes.ok && searchData.customers?.[0]?.id) {
    return searchData.customers[0].id;
  }

  // Create new customer
  const createRes = await fetch(`${SQUARE_BASE}/customers`, {
    method: "POST",
    headers: sqHeaders(),
    body: JSON.stringify({
      idempotency_key: `gf-cust-${quote.guest_email}-${Date.now()}`,
      given_name: quote.guest_first_name,
      family_name: quote.guest_last_name,
      email_address: quote.guest_email,
      phone_number: quote.guest_phone || undefined,
    }),
  });
  const createData = await createRes.json();
  if (createRes.ok && createData.customer?.id) {
    return createData.customer.id;
  }

  return null;
}
