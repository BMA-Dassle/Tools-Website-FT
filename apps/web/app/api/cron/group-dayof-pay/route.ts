import { NextRequest, NextResponse } from "next/server";
import { sql, isDbConfigured } from "@/lib/db";
import { parseGiftCardIds, type GroupFunctionQuote } from "@/lib/group-function-db";

/**
 * Day-of order payment cron for group function events.
 *
 * Runs every 5 minutes. Finds group function quotes where:
 *   - status = 'balance_charged' (fully funded — gift cards loaded)
 *   - event_date has arrived (event time passed)
 *   - dayof_paid_at IS NULL (not yet paid)
 *   - approval_required = FALSE (excludes post-paid accounts)
 *   - square_dayof_order_id IS NOT NULL
 *
 * For each: pays the day-of Square order using the gift card(s) via
 * multi-tender payments, then records the payment IDs.
 *
 * Matches the bowling lane-open pattern: gift card balance applied to
 * the open order, order left OPEN (staff completes on POS).
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
  if (process.env.VERCEL_ENV && process.env.VERCEL_ENV !== "production") {
    return NextResponse.json({ ok: true, skipped: "not production" });
  }

  if (!isDbConfigured()) {
    return NextResponse.json({ ok: false, error: "DB not configured" }, { status: 500 });
  }

  const dryRun = req.nextUrl.searchParams.get("dryRun") === "1";
  const q = sql();

  const quotes = (await q`
    SELECT * FROM group_function_quotes
    WHERE status = 'balance_charged'
      AND event_date <= NOW()
      AND dayof_paid_at IS NULL
      AND square_dayof_order_id IS NOT NULL
      AND (approval_required = FALSE OR approved_at IS NOT NULL)
    ORDER BY event_date ASC
    LIMIT 20
  `) as GroupFunctionQuote[];

  if (dryRun) {
    return NextResponse.json({
      ok: true,
      dryRun: true,
      count: quotes.length,
      quotes: quotes.map((q) => ({
        id: q.id,
        eventName: q.event_name,
        eventDate: q.event_date,
        dayofOrderId: q.square_dayof_order_id,
        giftCardCount: parseGiftCardIds(q.square_gift_card_id).length,
        totalCents: q.total_cents,
      })),
    });
  }

  let paid = 0;
  let errors = 0;

  for (const quote of quotes) {
    try {
      await payDayofOrder(quote);
      paid++;
    } catch (err) {
      errors++;
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[group-dayof-pay] failed quote=${quote.id}:`, errMsg);
      await q`UPDATE group_function_quotes SET
        dayof_payment_error = ${errMsg},
        updated_at = NOW()
      WHERE id = ${quote.id}`;
    }
  }

  console.log(`[group-dayof-pay] checked=${quotes.length} paid=${paid} errors=${errors}`);
  return NextResponse.json({ ok: true, checked: quotes.length, paid, errors });
}

async function payDayofOrder(quote: GroupFunctionQuote): Promise<void> {
  const orderId = quote.square_dayof_order_id!;
  const gcIds = parseGiftCardIds(quote.square_gift_card_id);
  const q = sql();

  if (gcIds.length === 0) {
    throw new Error("No gift card IDs found");
  }

  // Fetch the order to check state and remaining balance
  const orderRes = await fetch(`${SQUARE_BASE}/orders/${orderId}`, {
    headers: sqHeaders(),
  });
  if (!orderRes.ok) {
    throw new Error(`Failed to fetch order: ${orderRes.status}`);
  }
  const orderData = await orderRes.json();
  const order = orderData.order;

  if (!order) throw new Error("Order not found");

  if (order.state === "COMPLETED") {
    // Already paid — just record it
    await q`UPDATE group_function_quotes SET
      dayof_paid_at = NOW(),
      dayof_payment_ids = '[]'::jsonb,
      dayof_payment_error = NULL,
      updated_at = NOW()
    WHERE id = ${quote.id}`;
    console.log(`[group-dayof-pay] quote=${quote.id} order already COMPLETED`);
    return;
  }

  let remaining = order.net_amount_due_money?.amount ?? order.total_money?.amount ?? 0;
  if (remaining <= 0) {
    await q`UPDATE group_function_quotes SET
      dayof_paid_at = NOW(),
      dayof_payment_ids = '[]'::jsonb,
      dayof_payment_error = NULL,
      updated_at = NOW()
    WHERE id = ${quote.id}`;
    console.log(`[group-dayof-pay] quote=${quote.id} order has $0 remaining`);
    return;
  }

  const paymentIds: string[] = [];

  for (let i = 0; i < gcIds.length && remaining > 0; i++) {
    const gcId = gcIds[i];

    // Check gift card balance
    const gcRes = await fetch(`${SQUARE_BASE}/gift-cards/${gcId}`, {
      headers: sqHeaders(),
    });
    if (!gcRes.ok) {
      console.warn(
        `[group-dayof-pay] quote=${quote.id} failed to fetch gift card ${i}: ${gcRes.status}`,
      );
      continue;
    }
    const gcData = await gcRes.json();
    const gcBalance = gcData.gift_card?.balance_money?.amount ?? 0;

    if (gcBalance <= 0) {
      console.log(`[group-dayof-pay] quote=${quote.id} gift card ${i} has $0 balance`);
      continue;
    }

    const amountToPay = Math.min(gcBalance, remaining);

    const payRes = await fetch(`${SQUARE_BASE}/payments`, {
      method: "POST",
      headers: sqHeaders(),
      body: JSON.stringify({
        idempotency_key: `gf-dayof-pay-${quote.id}-${i}`,
        source_id: gcId,
        amount_money: { amount: amountToPay, currency: "USD" },
        order_id: orderId,
        location_id: quote.square_location_id,
        autocomplete: true,
        note: `Group event: ${quote.event_name || ""} (#${quote.event_number || quote.id})`,
      }),
    });

    if (payRes.ok) {
      const payData = await payRes.json();
      const paymentId = payData.payment?.id;
      const paidAmount = payData.payment?.amount_money?.amount ?? amountToPay;
      paymentIds.push(paymentId);
      remaining -= paidAmount;
      console.log(
        `[group-dayof-pay] quote=${quote.id} gc[${i}] charged $${(paidAmount / 100).toFixed(2)} ` +
          `paymentId=${paymentId} remaining=$${(remaining / 100).toFixed(2)}`,
      );
    } else {
      const errData = await payRes.json().catch(() => ({}));
      const errMsg = errData.errors?.[0]?.detail || `Payment failed (${payRes.status})`;
      console.error(`[group-dayof-pay] quote=${quote.id} gc[${i}] payment failed: ${errMsg}`);
    }
  }

  // Record results
  if (paymentIds.length > 0) {
    // Complete the order (no staff interaction for group events)
    if (remaining <= 0) {
      try {
        // Refetch order to get current version
        const freshRes = await fetch(`${SQUARE_BASE}/orders/${orderId}`, { headers: sqHeaders() });
        if (freshRes.ok) {
          const freshData = await freshRes.json();
          const version = freshData.order?.version;
          if (version) {
            await fetch(`${SQUARE_BASE}/orders/${orderId}`, {
              method: "PUT",
              headers: sqHeaders(),
              body: JSON.stringify({
                order: {
                  location_id: quote.square_location_id,
                  version,
                  state: "COMPLETED",
                },
              }),
            });
            console.log(`[group-dayof-pay] quote=${quote.id} order COMPLETED`);
          }
        }
      } catch (err) {
        console.warn(`[group-dayof-pay] quote=${quote.id} order complete failed (non-fatal):`, err);
      }
    }

    await q`UPDATE group_function_quotes SET
      dayof_paid_at = NOW(),
      dayof_payment_ids = ${JSON.stringify(paymentIds)}::jsonb,
      dayof_payment_error = ${remaining > 0 ? `$${(remaining / 100).toFixed(2)} remaining unpaid` : null},
      updated_at = NOW()
    WHERE id = ${quote.id}`;

    console.log(
      `[group-dayof-pay] quote=${quote.id} paid with ${paymentIds.length} gift card(s)` +
        (remaining > 0 ? ` — $${(remaining / 100).toFixed(2)} still remaining` : " — fully paid"),
    );
  } else {
    throw new Error("No gift card payments succeeded");
  }
}
