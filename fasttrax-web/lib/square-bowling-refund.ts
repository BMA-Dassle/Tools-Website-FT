/**
 * Square-side bowling cancellation / refund — shared logic.
 *
 * Extracted so both the customer-facing DELETE /reservations/[id] and
 * the QAMF webhook consumer can call it without going through an HTTP
 * fetch to our own endpoints.
 *
 * Steps:
 *   1. Fetch eGift card balance → authoritative refund amount
 *   2. Refund the deposit payment via /v2/refunds
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
  refundId: string;
  refundedCents: number;
  dayofOrderCancelled: boolean;
  giftCardDeactivated: boolean;
}

/**
 * Perform the full Square refund + cleanup for a cancelled bowling booking.
 *
 * @param depositPaymentId  Square payment ID to refund
 * @param giftCardId        Square eGift card ID (balance = exact refund amount)
 * @param locationId        Square location ID (center code or Square location ID)
 * @param idempotencyKey    UUID — callers must supply a stable, unique key per cancellation
 * @param dayofOrderId      Optional day-of order to cancel
 * @throws Error if the deposit refund fails (steps 3–4 are non-fatal)
 */
export async function processSquareBowlingRefund(opts: {
  depositPaymentId: string;
  giftCardId: string;
  locationId: string;
  idempotencyKey: string;
  dayofOrderId?: string;
}): Promise<BowlingRefundResult> {
  const { depositPaymentId, giftCardId, locationId, idempotencyKey, dayofOrderId } = opts;

  // ── 1. Get gift card balance ──────────────────────────────────────────
  const gcRes = await fetch(`${SQUARE_BASE}/gift-cards/${giftCardId}`, {
    headers: sqHeaders(),
  });
  if (!gcRes.ok) {
    const errBody = await gcRes.json().catch(() => ({})) as { errors?: { detail: string }[] };
    throw new Error(errBody.errors?.[0]?.detail ?? `Gift card lookup failed (${gcRes.status})`);
  }
  const gcData = (await gcRes.json()) as {
    gift_card?: { balance_money?: { amount?: number } };
  };
  const balance = gcData.gift_card?.balance_money?.amount;
  if (typeof balance !== "number" || balance <= 0) {
    throw new Error("Gift card has no balance to refund");
  }
  const refundAmountCents = balance;

  // ── 2. Refund the deposit payment (hard failure gate) ─────────────────
  const refundRes = await fetch(`${SQUARE_BASE}/refunds`, {
    method: "POST",
    headers: sqHeaders(),
    body: JSON.stringify({
      idempotency_key: idempotencyKey,
      payment_id: depositPaymentId,
      amount_money: { amount: refundAmountCents, currency: "USD" },
      reason: "Customer cancellation — full refund",
    }),
  });
  const refundData = (await refundRes.json()) as {
    refund?: { id: string; amount_money?: { amount?: number } };
    errors?: { code: string; detail: string }[];
  };
  if (!refundRes.ok) {
    const detail = refundData.errors?.[0]?.detail ?? "Refund failed";
    const code   = refundData.errors?.[0]?.code   ?? "REFUND_FAILED";
    throw new Error(`${detail} [${code}]`);
  }
  const refundId      = refundData.refund!.id;
  const refundedCents = refundData.refund!.amount_money?.amount ?? refundAmountCents;

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
        const currentState   = getJson.order?.state;
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
          deactivate_activity_details: { reason: "CHARGEBACK_DEACTIVATED" },
        },
      }),
    });
    if (deactivateRes.ok) giftCardDeactivated = true;
  } catch {
    // Non-fatal
  }

  return { refundId, refundedCents, dayofOrderCancelled, giftCardDeactivated };
}
