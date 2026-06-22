import { NextRequest, NextResponse } from "next/server";
import {
  getGfQuoteByShortId,
  updateGfBalanceCharged,
  updateGfGiftCardList,
  parseGiftCardIds,
  parseGiftCardGans,
  type GroupFunctionQuote,
} from "@/lib/group-function-db";
import { loadBalanceOntoGiftCards, SquarePaymentError } from "@/lib/square-gift-card";
import { serviceChargeCentsFromLineItems, buildPaymentLineItems } from "@/lib/service-charge";
import { notifyBalanceReceipt } from "@/lib/group-function-notify";
import { firePortalWebhookAsync } from "@/lib/portal-webhook";

/**
 * Self-hosted balance payment endpoint.
 *
 * POST /api/group-function/balance-pay { contractShortId, cardSourceId }
 *
 * Replaces Square-hosted payment links for the 72-hour balance fallback: the
 * /contract/{shortId}/pay page tokenizes the card and posts here, so the
 * charge, gift-card load, receipt, and status flip happen synchronously in
 * one request — no reconcile polling, no stuck 'balance_link_sent' records
 * (the #H2821 failure mode).
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
  const { contractShortId, cardSourceId, useSavedCard } = body as {
    contractShortId?: string;
    cardSourceId?: string;
    useSavedCard?: boolean;
  };

  if (!contractShortId || (!cardSourceId && !useSavedCard)) {
    return NextResponse.json(
      { error: "contractShortId and a card source are required" },
      { status: 400 },
    );
  }

  const quote = await getGfQuoteByShortId(contractShortId);
  if (!quote) {
    return NextResponse.json({ error: "Event not found" }, { status: 404 });
  }

  // "Re-charge" retries the card already on file (the one that just declined / a freshly
  // updated one); "Use a different card" passes a one-time token from the Square form.
  const sourceId = useSavedCard ? quote.saved_card_id : cardSourceId;
  if (!sourceId) {
    return NextResponse.json(
      { error: "No card on file to charge. Please enter a card.", code: "NO_SAVED_CARD" },
      { status: 400 },
    );
  }

  if (quote.balance_paid_at || quote.balance_cents <= 0) {
    return NextResponse.json({ ok: true, action: "already_paid" });
  }

  if (quote.status !== "deposit_paid" && quote.status !== "balance_link_sent") {
    return NextResponse.json(
      { error: `Cannot pay balance in status: ${quote.status}` },
      { status: 400 },
    );
  }

  // Stable per-attempt key: a double-click resolves to the SAME Square order +
  // payment (Square dedups on idempotency key), so the guest can't be charged
  // twice. A failed attempt bumps balance_charge_attempts, unlocking a fresh key.
  const baseKey = `gf-balpay-${quote.id}-${quote.balance_charge_attempts || 0}`;

  // Service charge is collected on the deposit first; only the remainder
  // (usually $0) lands on the balance — same split as the 72h auto-charge.
  const serviceChargeCents = serviceChargeCentsFromLineItems(quote.line_items);
  const balanceServiceCharge = Math.max(
    0,
    serviceChargeCents - Math.min(serviceChargeCents, quote.deposit_due_cents),
  );

  try {
    const orderRes = await fetch(`${SQUARE_BASE}/orders`, {
      method: "POST",
      headers: sqHeaders(),
      body: JSON.stringify({
        idempotency_key: `${baseKey}-order`,
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

    const payRes = await fetch(`${SQUARE_BASE}/payments`, {
      method: "POST",
      headers: sqHeaders(),
      body: JSON.stringify({
        idempotency_key: `${baseKey}-pay`,
        source_id: sourceId,
        amount_money: { amount: quote.balance_cents, currency: "USD" },
        order_id: balanceOrderId,
        location_id: quote.square_location_id,
        ...(quote.square_customer_id ? { customer_id: quote.square_customer_id } : {}),
        autocomplete: true,
        note: `GF Balance: ${quote.event_name || ""} (${quote.event_number || ""})`,
      }),
    });
    const payData = await payRes.json();
    if (!payRes.ok || payData.errors) {
      const sqErr = payData.errors?.[0];
      throw new SquarePaymentError(
        sqErr?.code ?? "CHARGE_FAILED",
        sqErr?.detail ?? "The card could not be charged.",
        payRes.status,
      );
    }
    const balancePaymentId = payData.payment?.id as string;
    const cardLast4 = payData.payment?.card_details?.card?.last_4 as string | undefined;

    // LOAD the balance onto the day-of gift cards ($2k balance cap per card;
    // overflow mints new cards which MUST be persisted for the day-of payout).
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
      balance_payment_method: "web",
    });

    // Confirm the BMI event immediately on full payment (non-fatal).
    try {
      const { updateProjectStatus, hasWaiverRequiredActivities } =
        await import("@/lib/bmi-office-actions");
      await updateProjectStatus({
        centerCode: quote.center_code,
        projectId: quote.bmi_reservation_id,
        hasWaiverActivities: hasWaiverRequiredActivities(
          (quote.line_items || []) as Array<{ name: string }>,
        ),
      });
    } catch (err) {
      console.error(`[gf-balance-pay] BMI confirm failed quote=${quote.id}:`, err);
    }

    console.log(
      `[gf-balance-pay] quote=${quote.id} charged $${(quote.balance_cents / 100).toFixed(2)} ` +
        `payment=${balancePaymentId}`,
    );

    // Receipt with waiver URL + card last4 (best-effort, non-fatal).
    (async () => {
      let waiverUrl: string | null = null;
      try {
        const { fetchProject } = await import("@/lib/bmi-office-actions");
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
      await notifyBalanceReceipt(
        {
          ...quote,
          balance_cents: 0,
          balance_paid_at: new Date().toISOString(),
          balance_payment_method: "web",
        } as GroupFunctionQuote,
        waiverUrl,
        cardLast4,
      );
    })().catch((err) => console.error("[gf-balance-pay] receipt notify error:", err));

    try {
      const { appendProjectPrivateNote, noteTimestamp } = await import("@/lib/bmi-office-actions");
      await appendProjectPrivateNote({
        centerCode: quote.center_code,
        projectId: quote.bmi_reservation_id,
        note: `[${noteTimestamp()}] Balance paid online: $${(quote.balance_cents / 100).toFixed(2)}`,
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

    return NextResponse.json({
      ok: true,
      action: "balance_paid",
      balanceCents: quote.balance_cents,
      cardLast4: cardLast4 ?? null,
    });
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    const errCode = err instanceof SquarePaymentError ? err.code : "UNKNOWN";

    try {
      const { sql } = await import("@/lib/db");
      const q = sql();
      await q`UPDATE group_function_quotes SET
        balance_charge_attempts = balance_charge_attempts + 1,
        balance_last_error = ${`${errCode}: ${errMsg}`.slice(0, 500)},
        updated_at = NOW()
      WHERE id = ${quote.id}`;
    } catch {
      /* attempt tracking is best-effort */
    }
    console.error(`[gf-balance-pay] quote=${quote.id} failed:`, errCode, errMsg);

    if (err instanceof SquarePaymentError) {
      // Persist the decline so the /pay page keeps showing the reason after reload.
      const { friendlyDeclineMessage, isCardDeclineCode } = await import("@/lib/square-decline");
      if (isCardDeclineCode(err.code)) {
        const { recordGfBalanceDecline } = await import("@/lib/group-function-db");
        const message = friendlyDeclineMessage(err.code, err.message);
        await recordGfBalanceDecline(quote.id, { code: err.code, message }).catch(() => {});
        return NextResponse.json(
          { error: message, code: err.code, declined: true },
          { status: 402 },
        );
      }
      return NextResponse.json({ error: err.message, code: err.code }, { status: 402 });
    }
    return NextResponse.json(
      { error: "Payment processing failed. Please try again." },
      { status: 500 },
    );
  }
}
