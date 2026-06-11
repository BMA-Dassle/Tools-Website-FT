import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "crypto";
import {
  getQuotesNeedingBalanceCharge,
  updateGfBalanceCharged,
  updateGfBalanceLinkSent,
  updateGfBalancePrepaid,
  updateGfGiftCardList,
  parseGiftCardIds,
  parseGiftCardGans,
  type GroupFunctionQuote,
} from "@/lib/group-function-db";
import { loadBalanceOntoGiftCards } from "@/lib/square-gift-card";
import { serviceChargeCentsFromLineItems, buildPaymentLineItems } from "@/lib/service-charge";
import { notifyBalanceReceipt, notifyBalanceLinkSent } from "@/lib/group-function-notify";
import { fetchProject } from "@/lib/bmi-office-actions";
import { verifyCron } from "@/lib/cron-auth";
import { firePortalWebhookAsync } from "@/lib/portal-webhook";

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
  const denied = verifyCron(req);
  if (denied) return denied;

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
  if (quote.balance_cents <= 0) {
    // Full-prepay (booked within 96h): entire amount taken at deposit, gift card already
    // loaded. Nothing to charge — advance status so the day-of payout/close crons run.
    // Without this, prepaid events stay 'deposit_paid' forever and never pay out day-of.
    await updateGfBalancePrepaid(quote.id);
    return "auto_charged";
  }

  // Staleness check: warn if quote hasn't been updated in 30+ days
  const daysSinceUpdate = (Date.now() - new Date(quote.updated_at).getTime()) / 86_400_000;
  if (daysSinceUpdate > 30) {
    console.warn(
      `[group-balance-charge] STALE quote=${quote.id} last updated ${Math.round(daysSinceUpdate)}d ago — charging anyway but event data may be outdated`,
    );
  }

  const baseKey = randomBytes(8).toString("hex");

  // Service charge is collected on the deposit first; only the remainder (usually $0)
  // lands on the balance. Break it out so the portal's Service Charges page detects it.
  const serviceChargeCents = serviceChargeCentsFromLineItems(quote.line_items);
  const balanceServiceCharge = Math.max(
    0,
    serviceChargeCents - Math.min(serviceChargeCents, quote.deposit_due_cents),
  );

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
            line_items: buildPaymentLineItems(
              "Group Event Balance",
              quote.balance_cents,
              balanceServiceCharge,
            ),
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

      // LOAD gift cards with balance amount ($2k max per card; overflow → new cards)
      const loaded = await loadBalanceOntoGiftCards({
        giftCardIds: parseGiftCardIds(quote.square_gift_card_id),
        locationId: quote.square_location_id,
        amountCents: quote.balance_cents,
        baseKey,
        buyerPaymentInstrumentIds: [balancePaymentId],
      });
      if (loaded.createdCards.length) {
        await updateGfGiftCardList(quote.id, {
          giftCardIds: loaded.giftCardIds,
          giftCardGans: [
            ...parseGiftCardGans(quote.square_gift_card_gan),
            ...loaded.createdCards.map((c) => c.gan ?? ""),
          ],
        });
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
        // Get card last4 from the payment
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
        await notifyBalanceReceipt(
          {
            ...quote,
            balance_cents: 0,
            balance_paid_at: new Date().toISOString(),
            balance_payment_method: "auto_card",
          },
          waiverUrl,
          cardLast4,
        );
      })().catch((err) => console.error("[group-balance-charge] receipt notify error:", err));

      try {
        const { appendProjectPrivateNote, noteTimestamp } =
          await import("@/lib/bmi-office-actions");
        await appendProjectPrivateNote({
          centerCode: quote.center_code,
          projectId: quote.bmi_reservation_id,
          note: `[${noteTimestamp()}] Balance charged: $${(quote.balance_cents / 100).toFixed(2)} via saved card`,
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

      return "auto_charged";
    } catch (err) {
      console.error(`[group-balance-charge] auto-charge failed for quote=${quote.id}:`, err);
      // Fall through to payment link
    }
  }

  // Path B: send the guest to our self-hosted balance payment page.
  // Square-hosted payment links are retired here: a paid quick-pay link's
  // backing order can sit OPEN forever and the DB only learns via the
  // reconcile poller (the #H2821 stuck-paid failure). Our page charges via
  // /api/group-function/balance-pay, which updates the DB synchronously.
  try {
    if (!quote.contract_short_id) {
      throw new Error(`quote=${quote.id} has no contract_short_id — cannot build pay page URL`);
    }
    const paymentLinkUrl = `${quote.base_url || "https://fasttraxent.com"}/contract/${quote.contract_short_id}/pay`;

    await updateGfBalanceLinkSent(quote.id, {
      balance_payment_link_url: paymentLinkUrl,
      balance_link_sent_at: new Date().toISOString(),
      balance_charge_attempts: (quote.balance_charge_attempts || 0) + 1,
      balance_last_error: quote.saved_card_id
        ? "Auto-charge failed, sent payment page"
        : "No saved card, sent payment page",
    });

    console.log(
      `[group-balance-charge] payment link sent for quote=${quote.id} ` + `url=${paymentLinkUrl}`,
    );

    notifyBalanceLinkSent({
      ...quote,
      balance_payment_link_url: paymentLinkUrl,
      balance_link_sent_at: new Date().toISOString(),
    }).catch((err) => console.error("[group-balance-charge] notify error:", err));

    try {
      const { appendProjectPrivateNote, noteTimestamp } = await import("@/lib/bmi-office-actions");
      await appendProjectPrivateNote({
        centerCode: quote.center_code,
        projectId: quote.bmi_reservation_id,
        note: `[${noteTimestamp()}] Balance link sent: $${(quote.balance_cents / 100).toFixed(2)} (auto-charge failed)`,
      });
    } catch {
      /* non-fatal */
    }

    firePortalWebhookAsync("payment.balance_link_sent", {
      documentId: quote.contract_short_id,
      bmiCode: quote.bmi_reservation_id,
      venue: quote.center_code,
      status: "balance_link_sent",
    });

    return "link_sent";
  } catch (err) {
    console.error(`[group-balance-charge] payment link failed for quote=${quote.id}:`, err);
    throw err;
  }
}
