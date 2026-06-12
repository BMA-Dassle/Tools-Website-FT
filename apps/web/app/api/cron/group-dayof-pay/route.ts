import { NextRequest, NextResponse } from "next/server";
import { sql, isDbConfigured } from "@/lib/db";
import { parseGiftCardIds, type GroupFunctionQuote } from "@/lib/group-function-db";
import { verifyCron } from "@/lib/cron-auth";

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
  const denied = verifyCron(req);
  if (denied) return denied;

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

  // Pay at the ORDER's location, not the quote's. Square rejects a payment
  // whose location differs from its order's — HeadPinz-brand events store the
  // FastTrax location on the quote while the day-of order is created at the
  // HeadPinz location, which stranded fully-funded events (H2821/H3011,
  // 2026-06-11): every CreatePayment failed and the cron retried forever.
  const payLocationId = order.location_id || quote.square_location_id;

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
  let lastPayError: string | null = null;
  // Plan the per-card contributions FIRST. Square refuses a payment attached
  // to an order unless it covers the order's full amount due, so a partial
  // single payment can never work: one card covering everything uses the
  // simple attach path; multiple cards must use the multi-tender PayOrder
  // flow (delayed-capture payments + POST /orders/{id}/pay). Discovered via
  // H2821 (2026-06-11): $2,231 due across a $2,000 + $231 card — both
  // CreatePayment attempts rejected/canceled forever.
  const plan: Array<{ gcId: string; amount: number; idx: number }> = [];
  let toCover = remaining;
  for (let i = 0; i < gcIds.length && toCover > 0; i++) {
    const gcRes = await fetch(`${SQUARE_BASE}/gift-cards/${gcIds[i]}`, {
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
    if (gcBalance <= 0) continue;
    const amount = Math.min(gcBalance, toCover);
    plan.push({ gcId: gcIds[i], amount, idx: i });
    toCover -= amount;
  }

  if (plan.length === 0) {
    throw new Error("No gift cards with available balance");
  }
  if (toCover > 0) {
    // Square cannot partially pay an order; leave it for staff with a clear note.
    throw new Error(
      `Gift cards $${(toCover / 100).toFixed(2)} short of the $${(remaining / 100).toFixed(2)} due — staff must settle at POS`,
    );
  }

  const note = `Group event: ${quote.event_name || ""} (#${quote.event_number || quote.id})`;

  if (plan.length === 1) {
    // Single card covers the full amount due — direct attach + autocomplete.
    // Location-salted key: pre-fix attempts burned `gf-dayof-pay-{id}-{i}`
    // with the wrong location; still stable per (quote, card, location) so
    // retries can never double-charge.
    const { gcId, amount, idx } = plan[0];
    const payRes = await fetch(`${SQUARE_BASE}/payments`, {
      method: "POST",
      headers: sqHeaders(),
      body: JSON.stringify({
        idempotency_key: `gf-dayof-pay-${quote.id}-${idx}-${payLocationId}`,
        source_id: gcId,
        amount_money: { amount, currency: "USD" },
        order_id: orderId,
        location_id: payLocationId,
        autocomplete: true,
        note,
      }),
    });
    if (payRes.ok) {
      const payData = await payRes.json();
      paymentIds.push(payData.payment?.id);
      remaining -= payData.payment?.amount_money?.amount ?? amount;
      console.log(
        `[group-dayof-pay] quote=${quote.id} gc[${idx}] charged $${(amount / 100).toFixed(2)} ` +
          `paymentId=${payData.payment?.id}`,
      );
    } else {
      const errData = await payRes.json().catch(() => ({}));
      lastPayError = errData.errors?.[0]?.detail || `Payment failed (${payRes.status})`;
      console.error(
        `[group-dayof-pay] quote=${quote.id} gc[${idx}] payment failed: ${lastPayError}`,
      );
    }
  } else {
    // Multi-tender: create delayed-capture payments (NOT attached to the
    // order), then attach + capture them atomically via PayOrder. The `mt`
    // key namespace is deliberate — earlier direct-attach attempts burned the
    // plain keys with rejected/canceled payments that Square replays forever.
    const created: string[] = [];
    let createFailed: string | null = null;
    for (const { gcId, amount, idx } of plan) {
      const payRes = await fetch(`${SQUARE_BASE}/payments`, {
        method: "POST",
        headers: sqHeaders(),
        body: JSON.stringify({
          idempotency_key: `gf-dayof-mt-${quote.id}-${idx}-${payLocationId}`,
          source_id: gcId,
          amount_money: { amount, currency: "USD" },
          location_id: payLocationId,
          autocomplete: false,
          note,
        }),
      });
      if (payRes.ok) {
        const payData = await payRes.json();
        created.push(payData.payment?.id);
      } else {
        const errData = await payRes.json().catch(() => ({}));
        createFailed = errData.errors?.[0]?.detail || `Payment create failed (${payRes.status})`;
        console.error(
          `[group-dayof-pay] quote=${quote.id} gc[${idx}] mt-create failed: ${createFailed}`,
        );
        break;
      }
    }

    if (createFailed) {
      // Void anything we authorized so gift-card funds aren't held hostage.
      for (const pid of created) {
        await fetch(`${SQUARE_BASE}/payments/${pid}/cancel`, {
          method: "POST",
          headers: sqHeaders(),
        }).catch(() => {});
      }
      lastPayError = createFailed;
    } else {
      const payOrderRes = await fetch(`${SQUARE_BASE}/orders/${orderId}/pay`, {
        method: "POST",
        headers: sqHeaders(),
        body: JSON.stringify({
          idempotency_key: `gf-dayof-payorder-${quote.id}-${payLocationId}`,
          order_version: order.version,
          payment_ids: created,
        }),
      });
      if (payOrderRes.ok) {
        paymentIds.push(...created);
        remaining = 0;
        console.log(
          `[group-dayof-pay] quote=${quote.id} PayOrder captured ${created.length} gift-card ` +
            `tenders for $${(plan.reduce((s, p) => s + p.amount, 0) / 100).toFixed(2)}`,
        );
      } else {
        const errData = await payOrderRes.json().catch(() => ({}));
        lastPayError = errData.errors?.[0]?.detail || `PayOrder failed (${payOrderRes.status})`;
        console.error(`[group-dayof-pay] quote=${quote.id} PayOrder failed: ${lastPayError}`);
        for (const pid of created) {
          await fetch(`${SQUARE_BASE}/payments/${pid}/cancel`, {
            method: "POST",
            headers: sqHeaders(),
          }).catch(() => {});
        }
      }
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
                  location_id: payLocationId,
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
    // Surface the real Square error in the DB — the generic message cost an
    // evening of log archaeology (2026-06-11).
    throw new Error(`No gift card payments succeeded${lastPayError ? `: ${lastPayError}` : ""}`);
  }
}
