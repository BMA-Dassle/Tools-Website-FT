/**
 * $20 legacy win-back incentive issuance.
 *
 * The incentive is minted the moment the guest adds a card on file (the
 * card-on-file deposit flow), per the chosen model. This helper is shared by
 * that flow and by a retry sweep (lib/group-function-db.getWinbackQuotesNeedingIncentive)
 * so a mint failure is retried. Idempotent: guarded on `incentive_issued_at`
 * + a stable Square baseKey, so it never double-mints.
 */
import {
  updateGfWinbackIncentiveIssued,
  appendAuditLog,
  type GroupFunctionQuote,
} from "@/lib/group-function-db";
import { mintDigitalGiftCard, findOrCreateSquareCustomer } from "@/lib/square-gift-card";
import { notifyWinbackReceipt } from "@/lib/group-function-notify";
import { withinQuietHours } from "@/lib/group-event-rules";

/**
 * Issue the $20 win-back e-gift card for a quote whose guest just added a card
 * on file. Returns true when this call minted+recorded the card, false if it
 * was already issued (or no discount configured). Never throws on the
 * already-issued race — only on a hard Square failure (so the caller/sweep retries).
 */
export async function issueWinbackIncentive(quote: GroupFunctionQuote): Promise<boolean> {
  if (quote.incentive_issued_at) return false;
  const cents = quote.incentive_cents || 2000;
  const discountId = process.env.SQUARE_WINBACK_DISCOUNT_ID;
  if (!discountId) {
    console.error("[winback] SQUARE_WINBACK_DISCOUNT_ID not set — cannot mint $20 incentive");
    return false;
  }

  const customerId = (await findOrCreateSquareCustomer(quote)) ?? undefined;
  const card = await mintDigitalGiftCard({
    locationId: quote.square_location_id,
    amountCents: cents,
    baseKey: `gf-winback-bonus-${quote.id}`, // stable ⇒ idempotent
    discountCatalogObjectId: discountId,
    customerId,
  });

  // DB guard: only the first writer records + notifies.
  const applied = await updateGfWinbackIncentiveIssued(quote.id, {
    gan: card.gan,
    giftCardId: card.giftCardId,
  });
  if (applied === 0) return false;

  await appendAuditLog({
    quoteId: quote.id,
    event: "winback_incentive_issued",
    metadata: { gan: card.gan, cents },
  });
  notifyWinbackReceipt(quote, card.gan, { smsSuppressed: withinQuietHours() }).catch((err) =>
    console.error(`[winback] receipt failed quote=${quote.id}:`, err),
  );
  return true;
}
