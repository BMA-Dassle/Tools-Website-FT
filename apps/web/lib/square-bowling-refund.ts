/**
 * Square-side bowling cancellation / refund — shared logic.
 *
 * Extracted so both the customer-facing DELETE /reservations/[id] and
 * the QAMF webhook consumer can call it without going through an HTTP
 * fetch to our own endpoints.
 *
 * Steps:
 *   1. Fetch eGift card balance → authoritative refund amount
 *   2. Refund the deposit. Multi-tender (customer paid with gift card +
 *      card) requires refunding EACH payment for its own tender amount —
 *      Square rejects a $X refund against a payment of only $Y where
 *      Y < X. When `depositOrderId` is provided we read tenders from the
 *      order and refund each. Otherwise we fall back to the legacy
 *      single-payment refund path.
 *   3. Cancel the day-of order (best-effort, non-fatal)
 *   4. Deactivate the gift card (best-effort, non-fatal)
 *
 * Only step 2 is a hard failure gate.
 */

const SQUARE_BASE = "https://connect.squareup.com/v2";
const SQUARE_VERSION = "2024-12-18";

function sqHeaders() {
  const token = process.env.SQUARE_ACCESS_TOKEN || "";
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "Square-Version": SQUARE_VERSION,
  };
}

export interface BowlingRefundResult {
  /** Primary refund id — first refund issued (kept for back-compat with single-tender callers). */
  refundId: string;
  /** All refund ids issued — one per tender. */
  refundIds: string[];
  refundedCents: number;
  dayofOrderCancelled: boolean;
  giftCardDeactivated: boolean;
}

/** One tender to refund — payment id + amount in cents. */
interface TenderRefund {
  paymentId: string;
  amountCents: number;
}

/**
 * Perform the full Square refund + cleanup for a cancelled bowling booking.
 *
 * @param depositPaymentId  Legacy single-payment refund target. Used when
 *                          `depositOrderId` is not provided.
 * @param depositOrderId    Deposit order id. When provided, this function
 *                          reads the order's tenders and refunds each
 *                          separately (required for multi-tender / split
 *                          payment bookings).
 * @param giftCardId        Square STAFF eGift card ID (balance = authoritative refund amount)
 * @param locationId        Square location ID
 * @param idempotencyKey    UUID — callers must supply a stable, unique key per cancellation
 * @param dayofOrderId      Optional day-of order to cancel
 * @throws Error if the deposit refund fails (steps 3–4 are non-fatal)
 */
export async function processSquareBowlingRefund(opts: {
  depositPaymentId: string;
  depositOrderId?: string;
  giftCardId: string;
  locationId: string;
  idempotencyKey: string;
  dayofOrderId?: string;
}): Promise<BowlingRefundResult> {
  const { depositPaymentId, depositOrderId, giftCardId, locationId, idempotencyKey, dayofOrderId } =
    opts;

  // ── 1. Get gift card balance ──────────────────────────────────────────
  const gcRes = await fetch(`${SQUARE_BASE}/gift-cards/${giftCardId}`, {
    headers: sqHeaders(),
  });
  if (!gcRes.ok) {
    const errBody = (await gcRes.json().catch(() => ({}))) as { errors?: { detail: string }[] };
    throw new Error(errBody.errors?.[0]?.detail ?? `Gift card lookup failed (${gcRes.status})`);
  }
  const gcData = (await gcRes.json()) as {
    gift_card?: { balance_money?: { amount?: number } };
  };
  const balance = gcData.gift_card?.balance_money?.amount;
  if (typeof balance !== "number" || balance <= 0) {
    throw new Error("Gift card has no balance to refund");
  }
  const totalRefundCents = balance;

  // ── 2. Determine the per-tender refund split ──────────────────────────
  // Multi-tender bookings (customer paid with a Square gift card + a card)
  // have two payments attached to the deposit order. We must refund each
  // payment for its own tender amount — Square rejects a refund larger
  // than the original payment.
  //
  // Single-tender bookings (legacy: card-only) fall through to one refund.
  let refunds: TenderRefund[] = [{ paymentId: depositPaymentId, amountCents: totalRefundCents }];

  if (depositOrderId) {
    try {
      const orderRes = await fetch(`${SQUARE_BASE}/orders/${depositOrderId}`, {
        headers: sqHeaders(),
      });
      if (orderRes.ok) {
        const orderJson = (await orderRes.json()) as {
          order?: {
            tenders?: Array<{
              payment_id?: string;
              amount_money?: { amount?: number };
            }>;
          };
        };
        const tenders = orderJson.order?.tenders ?? [];
        const tenderRefunds: TenderRefund[] = tenders
          .filter((t) => t.payment_id && (t.amount_money?.amount ?? 0) > 0)
          .map((t) => ({
            paymentId: t.payment_id as string,
            amountCents: t.amount_money?.amount as number,
          }));

        if (tenderRefunds.length > 0) {
          const tenderSum = tenderRefunds.reduce((s, t) => s + t.amountCents, 0);
          // When sum of tenders == staff eGift card balance, this is a
          // clean full refund. If they differ (partial redemption already
          // happened at the center), abort and require manual reconciliation
          // — proportional split between tenders is ambiguous and risks
          // refunding more than was actually paid on each payment.
          if (tenderSum !== totalRefundCents) {
            throw new Error(
              `Refund mismatch: order tenders sum to ${tenderSum} cents but staff eGift balance is ${totalRefundCents} cents. Partial redemption requires manual refund.`,
            );
          }
          refunds = tenderRefunds;
        }
      }
    } catch (err) {
      // If it's our own mismatch error, propagate (the booking can't be
      // safely auto-refunded). Otherwise fall back to legacy single-payment.
      if (err instanceof Error && err.message.startsWith("Refund mismatch:")) throw err;
      console.warn("[square-bowling-refund] order tender fetch failed, falling back:", err);
    }
  }

  // ── 2b. Issue one refund per tender ───────────────────────────────────
  const refundIds: string[] = [];
  let refundedCents = 0;
  for (let i = 0; i < refunds.length; i++) {
    const r = refunds[i];
    // Disambiguate idempotency keys so retrying a multi-tender cancel
    // doesn't collide across tenders.
    const idemKey = refunds.length === 1 ? idempotencyKey : `${idempotencyKey}-r${i}`;
    const refundRes = await fetch(`${SQUARE_BASE}/refunds`, {
      method: "POST",
      headers: sqHeaders(),
      body: JSON.stringify({
        idempotency_key: idemKey,
        payment_id: r.paymentId,
        amount_money: { amount: r.amountCents, currency: "USD" },
        reason: "Customer cancellation — full refund",
      }),
    });
    const refundData = (await refundRes.json()) as {
      refund?: { id: string; amount_money?: { amount?: number } };
      errors?: { code: string; detail: string }[];
    };
    if (!refundRes.ok) {
      const detail = refundData.errors?.[0]?.detail ?? "Refund failed";
      const code = refundData.errors?.[0]?.code ?? "REFUND_FAILED";
      throw new Error(`${detail} [${code}] (payment ${r.paymentId}, ${r.amountCents} cents)`);
    }
    refundIds.push(refundData.refund!.id);
    refundedCents += refundData.refund!.amount_money?.amount ?? r.amountCents;
  }
  const refundId = refundIds[0];

  // ── 3. Cancel day-of order (non-fatal) ────────────────────────────────
  let dayofOrderCancelled = false;
  if (dayofOrderId) {
    try {
      const getRes = await fetch(`${SQUARE_BASE}/orders/${dayofOrderId}`, {
        headers: sqHeaders(),
      });
      if (getRes.ok) {
        const getJson = (await getRes.json()) as { order?: { version?: number; state?: string } };
        const currentVersion = getJson.order?.version ?? 1;
        const currentState = getJson.order?.state;
        if (currentState !== "CANCELED" && currentState !== "COMPLETED") {
          const cancelRes = await fetch(`${SQUARE_BASE}/orders/${dayofOrderId}`, {
            method: "PUT",
            headers: sqHeaders(),
            body: JSON.stringify({
              order: { location_id: locationId, version: currentVersion, state: "CANCELED" },
              idempotency_key: `${idempotencyKey}-cancel`,
            }),
          });
          if (cancelRes.ok) dayofOrderCancelled = true;
        } else {
          dayofOrderCancelled = true;
        }
      }
    } catch {
      // Non-fatal
    }
  }

  // ── 4. Deactivate the gift card (non-fatal) ───────────────────────────
  let giftCardDeactivated = false;
  try {
    const deactivateRes = await fetch(`${SQUARE_BASE}/gift-cards/activities`, {
      method: "POST",
      headers: sqHeaders(),
      body: JSON.stringify({
        idempotency_key: `${idempotencyKey}-deactivate`,
        gift_card_activity: {
          type: "DEACTIVATE",
          location_id: locationId,
          gift_card_id: giftCardId,
          // Square's GiftCardActivityDeactivateReason enum lists
          // UNKNOWN_REASON / SUSPICIOUS_ACTIVITY / CHARGEBACK_DEACTIVATE,
          // but in practice Square only accepts SUSPICIOUS_ACTIVITY when
          // creating a deactivate activity via the API — the others are
          // reserved for Square's internal/dispute handling and return
          // "Reason is not valid for creating a deactivate giftcard
          // activity". Earlier code shipped "CHARGEBACK_DEACTIVATED"
          // (extra "D") which threw INVALID_ENUM_VALUE; the call is
          // try/catch non-fatal so refunds still landed but the staff
          // eGift card stayed ACTIVE on the Square dashboard, which can
          // mislead staff if a customer presents the GAN at the center
          // after a refunded booking.
          deactivate_activity_details: { reason: "SUSPICIOUS_ACTIVITY" },
        },
      }),
    });
    if (deactivateRes.ok) giftCardDeactivated = true;
  } catch {
    // Non-fatal
  }

  return { refundId, refundIds, refundedCents, dayofOrderCancelled, giftCardDeactivated };
}
