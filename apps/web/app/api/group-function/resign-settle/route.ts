import { NextRequest, NextResponse } from "next/server";
import { createHash } from "crypto";
import {
  getGfQuoteByShortId,
  updateGfRepriceCharged,
  updateGfResignNoCharge,
  appendAuditLog,
} from "@/lib/group-function-db";
import { chargeDeltaAndLoad } from "@/lib/group-function-reprice";
import { SquarePaymentError } from "@/lib/square-gift-card";
import { notifyRepriceCharged, notifyRepriceRefundOwed } from "@/lib/group-function-notify";
import { firePortalWebhookAsync } from "@/lib/portal-webhook";

/**
 * Finalize a re-sign and settle any money difference.
 *
 * POST /api/group-function/resign-settle
 * Body: { shortId, cardSourceId?, saveCard? }
 *
 * Called by the contract page right after the guest re-signs an updated
 * contract (replaces the old audit "re-signed" → deposit_paid flip).
 *
 * Behavior (amount_due = total_cents − collected_cents):
 *   - NOT paid in full (deposit-only resign)         → deposit_paid; 72hr cron collects later.
 *   - Paid in full, delta ≥ $1                        → charge the delta to the card on file
 *                                                       (or a captured card), load gift cards,
 *                                                       → balance_charged.
 *   - Paid in full, delta ≤ −$1 (overpaid)            → balance_charged; flag staff to refund.
 *   - Paid in full, |delta| < $1                      → balance_charged; no money movement.
 */

const MIN_DELTA_CENTS = 100; // skip charges/refunds under $1 (tax/rounding noise)

export async function POST(req: NextRequest) {
  // saveCard is implied: any captured card (cardSourceId present + no card on file) is saved.
  const { shortId, cardSourceId } = (await req.json()) as {
    shortId: string;
    cardSourceId?: string;
  };

  if (!shortId) {
    return NextResponse.json({ error: "shortId required" }, { status: 400 });
  }

  const quote = await getGfQuoteByShortId(shortId);
  if (!quote) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Idempotent: only act while awaiting re-sign settlement.
  if (quote.status !== "resign_required") {
    return NextResponse.json({ ok: true, action: "already_settled", status: quote.status });
  }

  const wasPaidInFull = Boolean(quote.balance_paid_at);
  const delta = quote.total_cents - quote.collected_cents;

  // Deposit-only resign (out of scope for delta charging): restore deposit_paid and let the
  // 72-hour balance cron collect the remaining balance, exactly as before.
  if (!wasPaidInFull) {
    await updateGfResignNoCharge(quote.id, "deposit_paid");
    await appendAuditLog({
      quoteId: quote.id,
      event: "resigned",
      metadata: { wasPaidInFull: false, balanceCents: quote.balance_cents },
    });
    await safePdfGenerate(shortId);
    return NextResponse.json({ ok: true, action: "resigned_deposit" });
  }

  // ── Paid in full ──────────────────────────────────────────────────

  // Price up by ≥ $1 → charge the difference.
  if (delta >= MIN_DELTA_CENTS) {
    const hasCardOnFile = Boolean(quote.saved_card_id);
    const sourceId = hasCardOnFile ? quote.saved_card_id! : cardSourceId;
    if (!sourceId) {
      return NextResponse.json(
        { error: "A card is required to collect the balance difference.", code: "CARD_REQUIRED" },
        { status: 400 },
      );
    }

    // Key on the settlement TARGET (quote.id + new total + card source). A genuine double-submit at
    // the same total reuses the key (Square dedupes → no double charge), but a re-price to a NEW total
    // gets a FRESH key, so its order/payment can never collide with a stale order created at the
    // previous total. (Incident: party 3354 — an OPEN $1,030.89 reprice order created at the old total
    // blocked every later attempt at the new total with a 402. `total_cents` works because after a
    // successful settle `collected_cents == total_cents` and `collected_cents` only ever rises, so a
    // given total is chargeable at most once per card — which also makes a charge-succeeded-but-DB-write-
    // failed retry replay safely.)
    const baseKey = `gf-reprice-${quote.id}-${quote.total_cents}-${createHash("sha256").update(sourceId).digest("hex").slice(0, 16)}`;

    try {
      const charge = await chargeDeltaAndLoad({
        quote,
        deltaCents: delta,
        sourceId,
        saveNewCard: !hasCardOnFile,
        baseKey,
      });

      const applied = await updateGfRepriceCharged(quote.id, {
        collected_cents: quote.total_cents,
        saved_card_id: charge.savedCardId,
        saved_card_last4: charge.savedCardLast4,
        saved_card_brand: charge.savedCardBrand,
        square_customer_id: charge.squareCustomerId,
      });

      if (applied === 0) {
        // A concurrent settle won the race; Square idempotency prevented a double charge.
        return NextResponse.json({ ok: true, action: "already_settled" });
      }

      await appendAuditLog({
        quoteId: quote.id,
        event: "reprice_charged",
        metadata: {
          deltaCents: delta,
          newTotalCents: quote.total_cents,
          paymentId: charge.paymentId,
          orderId: charge.orderId,
          savedNewCard: !hasCardOnFile,
        },
      });

      const refreshed = await getGfQuoteByShortId(shortId);
      const last4 = charge.savedCardLast4 || quote.saved_card_last4 || undefined;
      if (refreshed) {
        notifyRepriceCharged(refreshed, delta, last4).catch((err) =>
          console.error("[resign-settle] repriceCharged notify error:", err),
        );
      }

      firePortalWebhookAsync("payment.balance_charged", {
        documentId: quote.contract_short_id,
        bmiCode: quote.bmi_reservation_id,
        venue: quote.center_code,
        status: "balance_charged",
      });

      await safePdfGenerate(shortId);
      return NextResponse.json({ ok: true, action: "reprice_charged", chargedCents: delta });
    } catch (err) {
      if (err instanceof SquarePaymentError) {
        // Surface the Square failure in the audit trail so the next incident is diagnosable from the
        // DB instead of requiring a live Square query. Best-effort — never mask the original error.
        await appendAuditLog({
          quoteId: quote.id,
          event: "reprice_charge_failed",
          metadata: {
            code: err.code,
            detail: err.message,
            deltaCents: delta,
            totalCents: quote.total_cents,
          },
        }).catch((logErr) =>
          console.error("[resign-settle] failed to append reprice_charge_failed audit:", logErr),
        );
        return NextResponse.json({ error: err.message, code: err.code }, { status: 402 });
      }
      console.error("[resign-settle] charge failed:", err);
      return NextResponse.json(
        { error: "Could not collect the balance difference. Please try again." },
        { status: 500 },
      );
    }
  }

  // Price down by ≥ $1 → overpaid. No auto-refund; flag staff.
  if (delta <= -MIN_DELTA_CENTS) {
    const applied = await updateGfResignNoCharge(quote.id, "balance_charged");
    if (applied > 0) {
      await appendAuditLog({
        quoteId: quote.id,
        event: "reprice_refund_owed",
        metadata: { overageCents: -delta, newTotalCents: quote.total_cents },
      });
      notifyRepriceRefundOwed(quote, -delta).catch((err) =>
        console.error("[resign-settle] refundOwed notify error:", err),
      );
    }
    await safePdfGenerate(shortId);
    return NextResponse.json({ ok: true, action: "refund_owed", overageCents: -delta });
  }

  // |delta| < $1 → no money movement.
  await updateGfResignNoCharge(quote.id, "balance_charged");
  await safePdfGenerate(shortId);
  return NextResponse.json({ ok: true, action: "no_change" });
}

async function safePdfGenerate(shortId: string) {
  try {
    const { generateAndStorePdf } = await import("@/lib/contract-pdf-generate");
    await generateAndStorePdf(shortId);
  } catch (err) {
    console.error("[resign-settle] PDF generation failed:", err);
  }
}
