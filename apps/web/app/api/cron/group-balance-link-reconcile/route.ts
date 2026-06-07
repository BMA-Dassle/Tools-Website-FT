import { NextRequest, NextResponse } from "next/server";
import {
  getQuotesWithPendingBalanceLinks,
  updateGfBalanceCharged,
  parseGiftCardIds,
  type GroupFunctionQuote,
} from "@/lib/group-function-db";
import { loadBalanceOntoGiftCards } from "@/lib/square-gift-card";
import { notifyBalanceReceipt } from "@/lib/group-function-notify";
import { fetchProject } from "@/lib/bmi-office-actions";
import { verifyCron } from "@/lib/cron-auth";
import { firePortalWebhookAsync } from "@/lib/portal-webhook";

/**
 * Balance payment-link reconcile cron.
 *
 * The 72-hour balance cron falls back to a Square payment link when there's no
 * card on file (or auto-charge fails) and sets status = 'balance_link_sent'.
 * Nothing else ever marked those links paid — so a customer could pay and our
 * DB still showed the balance outstanding, and the day-of gift cards were never
 * loaded. This poller closes that gap.
 *
 * Every ~15 min, for each quote in 'balance_link_sent':
 *   - look up the link's backing Square order
 *   - if it's COMPLETED (paid), LOAD the balance onto the day-of gift cards and
 *     mark the quote balance_charged (method 'link'), which also sets
 *     collected_cents = total_cents so reprice math is correct.
 *
 * Query params:
 *   ?dryRun=1  — scan + report, no charges/loads
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

type ReconcileResult = "reconciled" | "pending" | "unreconcilable";

export async function GET(req: NextRequest) {
  const denied = verifyCron(req);
  if (denied) return denied;

  const dryRun = req.nextUrl.searchParams.get("dryRun") === "1";

  let quotes: GroupFunctionQuote[];
  try {
    quotes = await getQuotesWithPendingBalanceLinks();
  } catch (err) {
    console.error("[group-balance-link-reconcile] DB query failed:", err);
    return NextResponse.json({ ok: false, error: "DB query failed" }, { status: 500 });
  }

  if (dryRun) {
    const scanned = await Promise.all(
      quotes.map(async (q) => ({
        id: q.id,
        eventName: q.event_name,
        balanceCents: q.balance_cents,
        orderId: q.square_balance_order_id,
        paid: await isLinkOrderPaid(q),
      })),
    );
    return NextResponse.json({ ok: true, dryRun: true, count: quotes.length, quotes: scanned });
  }

  const results = await Promise.allSettled(quotes.map((q) => reconcileQuote(q)));

  const summary = { total: quotes.length, reconciled: 0, pending: 0, unreconcilable: 0, errors: 0 };
  for (const r of results) {
    if (r.status === "fulfilled") {
      if (r.value === "reconciled") summary.reconciled++;
      else if (r.value === "pending") summary.pending++;
      else summary.unreconcilable++;
    } else {
      summary.errors++;
    }
  }

  console.log(
    `[group-balance-link-reconcile] total=${summary.total} reconciled=${summary.reconciled} ` +
      `pending=${summary.pending} unreconcilable=${summary.unreconcilable} errors=${summary.errors}`,
  );

  return NextResponse.json({ ok: true, ...summary });
}

/** Resolve the Square order id backing a balance payment link. */
async function resolveLinkOrderId(quote: GroupFunctionQuote): Promise<string | null> {
  if (quote.square_balance_order_id) return quote.square_balance_order_id;
  // Legacy link sent before we captured the order id — recover it from the link.
  if (quote.square_balance_link_id) {
    try {
      const res = await fetch(
        `${SQUARE_BASE}/online-checkout/payment-links/${quote.square_balance_link_id}`,
        { headers: sqHeaders() },
      );
      if (res.ok) {
        const data = await res.json();
        return (data.payment_link?.order_id as string) || null;
      }
    } catch {
      /* fall through */
    }
  }
  return null;
}

/** Retrieve the backing order and report whether it's been paid. */
async function isLinkOrderPaid(quote: GroupFunctionQuote): Promise<boolean> {
  const orderId = await resolveLinkOrderId(quote);
  if (!orderId) return false;
  try {
    const res = await fetch(`${SQUARE_BASE}/orders/${orderId}`, { headers: sqHeaders() });
    if (!res.ok) return false;
    const data = await res.json();
    return data.order?.state === "COMPLETED";
  } catch {
    return false;
  }
}

async function reconcileQuote(quote: GroupFunctionQuote): Promise<ReconcileResult> {
  const orderId = await resolveLinkOrderId(quote);
  if (!orderId) {
    console.warn(
      `[group-balance-link-reconcile] quote=${quote.id} has no resolvable balance order id — skipping`,
    );
    return "unreconcilable";
  }

  const orderRes = await fetch(`${SQUARE_BASE}/orders/${orderId}`, { headers: sqHeaders() });
  if (!orderRes.ok) {
    throw new Error(`Order fetch failed (${orderRes.status}) for quote=${quote.id}`);
  }
  const orderData = await orderRes.json();
  const order = orderData.order;
  if (!order || order.state !== "COMPLETED") {
    return "pending"; // not paid yet — try again next run
  }

  // Paid. The link payment funds the gift-card load (best-effort instrument link).
  const tender = (order.tenders || [])[0] as { id?: string; payment_id?: string } | undefined;
  const balancePaymentId = tender?.payment_id || tender?.id || "";

  // LOAD the balance onto the day-of gift cards so group-dayof-pay stays fully funded.
  // Stable baseKey keyed on the quote → re-runs are idempotent (Square dedups the load).
  const baseKey = `gf-linkrec-${quote.id}`;
  await loadBalanceOntoGiftCards({
    giftCardIds: parseGiftCardIds(quote.square_gift_card_id),
    locationId: quote.square_location_id,
    amountCents: quote.balance_cents,
    baseKey,
    buyerPaymentInstrumentIds: balancePaymentId ? [balancePaymentId] : [],
  });

  await updateGfBalanceCharged(quote.id, {
    square_balance_order_id: orderId,
    square_balance_payment_id: balancePaymentId,
    balance_paid_at: new Date().toISOString(),
    balance_payment_method: "link",
  });

  console.log(
    `[group-balance-link-reconcile] reconciled quote=${quote.id} ` +
      `amount=${quote.balance_cents} order=${orderId} payment=${balancePaymentId}`,
  );

  // Receipt + ops trail (best-effort, non-fatal).
  (async () => {
    let waiverUrl: string | null = null;
    let cardLast4: string | undefined;
    try {
      const project = await fetchProject(quote.center_code, quote.bmi_reservation_id);
      if (project?.projectReference) {
        const clientKeys: Record<string, string> = {
          "fort-myers": "headpinzftmyers",
          fasttrax: "headpinzftmyers",
          naples: "headpinznaples",
        };
        const ck = clientKeys[quote.center_code] || "headpinzftmyers";
        waiverUrl = `https://kiosk.sms-timing.com/${ck}/subscribe/event?id=${encodeURIComponent(project.projectReference as string)}`;
      }
    } catch {
      /* non-fatal */
    }
    if (balancePaymentId) {
      try {
        const payRes = await fetch(`${SQUARE_BASE}/payments/${balancePaymentId}`, {
          headers: sqHeaders(),
        });
        if (payRes.ok) {
          const payData = await payRes.json();
          cardLast4 = payData.payment?.card_details?.card?.last_4;
        }
      } catch {
        /* non-fatal */
      }
    }
    await notifyBalanceReceipt(
      {
        ...quote,
        balance_cents: 0,
        balance_paid_at: new Date().toISOString(),
        balance_payment_method: "link",
      },
      waiverUrl,
      cardLast4,
    );
  })().catch((err) => console.error("[group-balance-link-reconcile] receipt notify error:", err));

  try {
    const { appendProjectPrivateNote, noteTimestamp } = await import("@/lib/bmi-office-actions");
    await appendProjectPrivateNote({
      centerCode: quote.center_code,
      projectId: quote.bmi_reservation_id,
      note: `[${noteTimestamp()}] Balance paid via link: $${(quote.balance_cents / 100).toFixed(2)}`,
    });
  } catch {
    /* non-fatal */
  }

  firePortalWebhookAsync("payment.balance_charged", {
    documentId: quote.contract_short_id,
    bmiCode: quote.bmi_reservation_id,
    venue: quote.center_code,
    status: "balance_charged",
  });

  return "reconciled";
}
