import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "crypto";
import {
  getQuotesNeedingBalanceCharge,
  updateGfBalanceCharged,
  updateGfBalanceLinkSent,
  parseGiftCardIds,
  type GroupFunctionQuote,
} from "@/lib/group-function-db";
import { loadGiftCard } from "@/lib/square-gift-card";
import { notifyBalanceReceipt, notifyBalanceLinkSent } from "@/lib/group-function-notify";
import { fetchProject } from "@/lib/bmi-office-actions";

/**
 * 72-hour balance collection cron.
 *
 * Every 15 minutes, finds group function quotes where:
 *   - status = 'deposit_paid'
 *   - event is within 72 hours
 *   - event hasn't passed yet
 *
 * Path A: auto-charge saved card → LOAD gift card to 100%
 * Path B: create Square payment link → send to customer
 *
 * Query params:
 *   ?dryRun=1  — scan + report, no charges
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

export async function GET(req: NextRequest) {
  const dryRun = req.nextUrl.searchParams.get("dryRun") === "1";

  let quotes: GroupFunctionQuote[];
  try {
    quotes = await getQuotesNeedingBalanceCharge();
  } catch (err) {
    console.error("[group-balance-charge] DB query failed:", err);
    return NextResponse.json({ ok: false, error: "DB query failed" }, { status: 500 });
  }

  if (dryRun) {
    return NextResponse.json({
      ok: true,
      dryRun: true,
      count: quotes.length,
      quotes: quotes.map((q) => ({
        id: q.id,
        eventName: q.event_name,
        eventDate: q.event_date,
        balanceCents: q.balance_cents,
        hasSavedCard: Boolean(q.saved_card_id),
      })),
    });
  }

  const results = await Promise.allSettled(quotes.map((q) => processBalanceCharge(q)));

  const summary = {
    total: quotes.length,
    autoCharged: 0,
    linksSent: 0,
    errors: 0,
  };

  for (const r of results) {
    if (r.status === "fulfilled") {
      if (r.value === "auto_charged") summary.autoCharged++;
      else if (r.value === "link_sent") summary.linksSent++;
    } else {
      summary.errors++;
    }
  }

  console.log(
    `[group-balance-charge] total=${summary.total} auto=${summary.autoCharged} ` +
      `links=${summary.linksSent} errors=${summary.errors}`,
  );

  return NextResponse.json({ ok: true, ...summary });
}

async function processBalanceCharge(
  quote: GroupFunctionQuote,
): Promise<"auto_charged" | "link_sent"> {
  if (quote.balance_cents <= 0) return "auto_charged";

  // Staleness check: warn if quote hasn't been updated in 30+ days
  const daysSinceUpdate = (Date.now() - new Date(quote.updated_at).getTime()) / 86_400_000;
  if (daysSinceUpdate > 30) {
    console.warn(
      `[group-balance-charge] STALE quote=${quote.id} last updated ${Math.round(daysSinceUpdate)}d ago — charging anyway but event data may be outdated`,
    );
  }

  const baseKey = randomBytes(8).toString("hex");

  // Path A: auto-charge saved card
  if (quote.saved_card_id && quote.square_customer_id) {
    try {
      // Create balance order
      const orderRes = await fetch(`${SQUARE_BASE}/orders`, {
        method: "POST",
        headers: sqHeaders(),
        body: JSON.stringify({
          idempotency_key: `gf-bal-order-${baseKey}`,
          order: {
            location_id: quote.square_location_id,
            reference_id: `GF Balance: ${quote.event_number || ""}`.slice(0, 40),
            line_items: [
              {
                name: "Group Event Balance",
                quantity: "1",
                base_price_money: {
                  amount: quote.balance_cents,
                  currency: "USD",
                },
              },
            ],
          },
        }),
      });
      const orderData = await orderRes.json();
      if (!orderRes.ok || !orderData.order?.id) {
        throw new Error(`Balance order failed: ${JSON.stringify(orderData).slice(0, 200)}`);
      }
      const balanceOrderId = orderData.order.id as string;

      // Charge saved card
      const payRes = await fetch(`${SQUARE_BASE}/payments`, {
        method: "POST",
        headers: sqHeaders(),
        body: JSON.stringify({
          idempotency_key: `gf-bal-pay-${baseKey}`,
          source_id: quote.saved_card_id,
          amount_money: { amount: quote.balance_cents, currency: "USD" },
          order_id: balanceOrderId,
          location_id: quote.square_location_id,
          customer_id: quote.square_customer_id,
          autocomplete: true,
          note: `GF Balance: ${quote.event_name || ""} (${quote.event_number || ""})`,
        }),
      });
      const payData = await payRes.json();
      if (!payRes.ok || payData.errors) {
        const errCode = payData.errors?.[0]?.code || "CHARGE_FAILED";
        throw new Error(`Balance charge failed: ${errCode}`);
      }
      const balancePaymentId = payData.payment?.id as string;

      // LOAD gift cards with balance amount ($2k max per card)
      const gcIds = parseGiftCardIds(quote.square_gift_card_id);
      const GC_MAX_CENTS = 200_000;
      let loadRemaining = quote.balance_cents;
      for (let i = 0; i < gcIds.length && loadRemaining > 0; i++) {
        const loadAmount = Math.min(loadRemaining, GC_MAX_CENTS);
        await loadGiftCard({
          giftCardId: gcIds[i],
          locationId: quote.square_location_id,
          amountCents: loadAmount,
          baseKey: `${baseKey}-${i}`,
          buyerPaymentInstrumentIds: [balancePaymentId],
        });
        loadRemaining -= loadAmount;
      }
      // If balance exceeds existing cards' capacity, create new cards
      let newGcIndex = gcIds.length;
      while (loadRemaining > 0) {
        const chunkCents = Math.min(loadRemaining, GC_MAX_CENTS);
        const gcRes = await fetch(`${SQUARE_BASE}/gift-cards`, {
          method: "POST",
          headers: sqHeaders(),
          body: JSON.stringify({
            idempotency_key: `gf-bal-gc-${baseKey}-${newGcIndex}`,
            location_id: quote.square_location_id,
            gift_card: { type: "DIGITAL" },
          }),
        });
        const gcData = await gcRes.json();
        if (gcRes.ok && gcData.gift_card?.id) {
          await fetch(`${SQUARE_BASE}/gift-cards/activities`, {
            method: "POST",
            headers: sqHeaders(),
            body: JSON.stringify({
              idempotency_key: `gf-bal-gc-act-${baseKey}-${newGcIndex}`,
              gift_card_activity: {
                type: "ACTIVATE",
                location_id: quote.square_location_id,
                gift_card_id: gcData.gift_card.id,
                activate_activity_details: {
                  amount_money: { amount: chunkCents, currency: "USD" },
                  buyer_payment_instrument_ids: [balancePaymentId],
                },
              },
            }),
          });
          gcIds.push(gcData.gift_card.id);
        }
        loadRemaining -= chunkCents;
        newGcIndex++;
      }

      await updateGfBalanceCharged(quote.id, {
        square_balance_order_id: balanceOrderId,
        square_balance_payment_id: balancePaymentId,
        balance_paid_at: new Date().toISOString(),
        balance_payment_method: "auto_card",
      });

      console.log(
        `[group-balance-charge] auto-charged quote=${quote.id} ` +
          `amount=${quote.balance_cents} payment=${balancePaymentId}`,
      );

      // Send receipt email with waiver URL and card last4
      (async () => {
        let waiverUrl: string | null = null;
        let cardLast4: string | undefined;
        try {
          const project = await fetchProject(quote.center_code, quote.bmi_reservation_id);
          if (project?.projectReference) {
            const clientKeys: Record<string, string> = { "fort-myers": "headpinzftmyers", fasttrax: "headpinzftmyers", naples: "headpinznaples" };
            const ck = clientKeys[quote.center_code] || "headpinzftmyers";
            waiverUrl = `https://kiosk.sms-timing.com/${ck}/subscribe/event?id=${encodeURIComponent(project.projectReference as string)}`;
          }
        } catch { /* non-fatal */ }
        // Get card last4 from the payment
        try {
          const payRes = await fetch(`${SQUARE_BASE}/payments/${balancePaymentId}`, { headers: sqHeaders() });
          if (payRes.ok) {
            const payData = await payRes.json();
            cardLast4 = payData.payment?.card_details?.card?.last_4;
          }
        } catch { /* non-fatal */ }
        await notifyBalanceReceipt(
          { ...quote, balance_cents: 0, balance_paid_at: new Date().toISOString(), balance_payment_method: "auto_card" },
          waiverUrl,
          cardLast4,
        );
      })().catch((err) => console.error("[group-balance-charge] receipt notify error:", err));

      return "auto_charged";
    } catch (err) {
      console.error(`[group-balance-charge] auto-charge failed for quote=${quote.id}:`, err);
      // Fall through to payment link
    }
  }

  // Path B: create payment link
  try {
    const linkRes = await fetch(`${SQUARE_BASE}/online-checkout/payment-links`, {
      method: "POST",
      headers: sqHeaders(),
      body: JSON.stringify({
        idempotency_key: `gf-bal-link-${baseKey}`,
        quick_pay: {
          name: `Event Balance: ${quote.event_name || "Group Event"}`,
          price_money: { amount: quote.balance_cents, currency: "USD" },
          location_id: quote.square_location_id,
        },
      }),
    });
    const linkData = await linkRes.json();
    if (!linkRes.ok || !linkData.payment_link?.url) {
      throw new Error(`Payment link failed: ${JSON.stringify(linkData).slice(0, 200)}`);
    }
    const paymentLinkUrl = linkData.payment_link.url as string;

    await updateGfBalanceLinkSent(quote.id, {
      balance_payment_link_url: paymentLinkUrl,
      balance_link_sent_at: new Date().toISOString(),
      balance_charge_attempts: (quote.balance_charge_attempts || 0) + 1,
      balance_last_error: quote.saved_card_id
        ? "Auto-charge failed, sent payment link"
        : "No saved card, sent payment link",
    });

    console.log(
      `[group-balance-charge] payment link sent for quote=${quote.id} ` + `url=${paymentLinkUrl}`,
    );

    notifyBalanceLinkSent({
      ...quote,
      balance_payment_link_url: paymentLinkUrl,
      balance_link_sent_at: new Date().toISOString(),
    }).catch((err) => console.error("[group-balance-charge] notify error:", err));

    return "link_sent";
  } catch (err) {
    console.error(`[group-balance-charge] payment link failed for quote=${quote.id}:`, err);
    throw err;
  }
}
