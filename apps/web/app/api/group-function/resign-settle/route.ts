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

/**
 * Re-confirm the BMI project after a re-sign settles. A price change sets the quote to
 * `resign_required` and resets the BMI project to "Pending Signed Contract"; the deposit
 * route is the only place that confirmed BMI, so before this a re-signed event sat stuck
 * at "Pending Signed Contract" forever (Suffolk 49972983, 2026-06-22 — "signed but BMI
 * never moved to confirmation"). Mirrors the deposit route's BMI block; non-fatal.
 */
async function reconfirmBmi(
  quote: {
    id: number;
    center_code: string;
    bmi_reservation_id: string;
    line_items: unknown;
  },
  recordPaymentCents?: number,
) {
  // Single point: confirm BMI + (optionally) record the just-charged reprice delta.
  const { confirmAndRecordBmiPayment } = await import("@/lib/bmi-office-actions");
  await confirmAndRecordBmiPayment({
    centerCode: quote.center_code,
    projectId: quote.bmi_reservation_id,
    lineItems: (quote.line_items || []) as Array<{ name: string }>,
    amountDollars: (recordPaymentCents ?? 0) / 100,
  });
}

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
    await reconfirmBmi(quote);
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

    // Square caps the PAYMENT and CARD idempotency_key at 45 chars. The keys derived from baseKey are
    // `gf-reprice-pay-${baseKey}` / `gf-reprice-card-${baseKey}` (+15/16 chars), so baseKey MUST stay
    // short — a plaintext `gf-reprice-${id}-…` key already blew past 45 once the quote id reached 3
    // digits (incident: party 3354 → `gf-reprice-pay-gf-reprice-143-…` = 46+ chars → Square
    // VALUE_TOO_LONG → every charge failed before a payment was ever created).
    //
    // Use a FIXED-length hash over the fields that make this charge unique — quote, TARGET total, and
    // card source — so the key can never grow past the limit regardless of id/total magnitude. Keying on
    // total_cents means a re-price to a new total ⇒ fresh key ⇒ fresh order/payment (can't collide with a
    // stale order created at the previous total), while a true double-submit at the same total reuses the
    // key (Square dedupes ⇒ no double charge, and a charge-succeeded-but-DB-write-failed retry replays
    // safely, since after a successful settle collected_cents == total_cents and only ever rises).
    const baseKey = createHash("sha256")
      .update(`gf-reprice:${quote.id}:${quote.total_cents}:${sourceId}`)
      .digest("hex")
      .slice(0, 24);

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

      await reconfirmBmi(quote, delta);
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
    await reconfirmBmi(quote);
    await safePdfGenerate(shortId);
    return NextResponse.json({ ok: true, action: "refund_owed", overageCents: -delta });
  }

  // |delta| < $1 → no money movement.
  await updateGfResignNoCharge(quote.id, "balance_charged");
  await reconfirmBmi(quote);
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
