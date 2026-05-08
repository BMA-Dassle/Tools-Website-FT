import { NextRequest, NextResponse } from "next/server";

/**
 * POST /api/square/bowling-refund
 *
 * Handles the Square side of cancelling a paid bowling booking:
 *   1. Fetches the eGift card balance — this is the authoritative refund amount
 *      (exact cents charged at booking; no tax-rounding guesswork)
 *   2. Refunds the original deposit payment in full via Square /v2/refunds
 *   3. Cancels the day-of order (moves it to CANCELED state) — best-effort
 *   4. Deactivates the eGift card to prevent reuse — best-effort
 *
 * Step 2 is the only hard-failure gate. Steps 3–4 are non-fatal so the
 * caller (DELETE /api/bowling/v2/reservations/[id]) can always mark the
 * Neon row as cancelled after a successful refund.
 *
 * Request body:
 * {
 *   depositPaymentId: string   — Square payment ID to refund
 *   giftCardId:       string   — Square eGift card ID
 *   dayofOrderId?:    string   — Square day-of order ID (cancel it)
 *   locationId:       string   — Square location ID
 *   idempotencyKey:   string   — UUID for dedup
 * }
 *
 * Response (200):
 * {
 *   refundId:            string
 *   refundedCents:       number
 *   dayofOrderCancelled: boolean
 *   giftCardDeactivated: boolean
 * }
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

interface RefundBody {
  depositPaymentId: string;
  giftCardId: string;
  dayofOrderId?: string;
  locationId: string;
  idempotencyKey: string;
}

export async function POST(req: NextRequest) {
  let body: RefundBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const { depositPaymentId, giftCardId, dayofOrderId, locationId, idempotencyKey } = body;

  if (!depositPaymentId || !giftCardId || !locationId || !idempotencyKey) {
    return NextResponse.json(
      { error: "depositPaymentId, giftCardId, locationId, idempotencyKey are required" },
      { status: 400 },
    );
  }

  // ── 1. Get gift card balance (= exact amount to refund) ───────────────────
  // The card was loaded with the exact charged amount at booking time, so its
  // balance is always the correct refund figure — no recalculation needed.
  let refundAmountCents: number;
  try {
    const gcRes = await fetch(`${SQUARE_BASE}/gift-cards/${giftCardId}`, {
      headers: sqHeaders(),
    });
    if (!gcRes.ok) {
      const errBody = await gcRes.json().catch(() => ({})) as {
        errors?: { detail: string }[];
      };
      const detail = errBody.errors?.[0]?.detail ?? "Gift card lookup failed";
      return NextResponse.json({ error: detail }, { status: gcRes.status });
    }
    const gcData = (await gcRes.json()) as {
      gift_card?: { balance_money?: { amount?: number } };
    };
    const balance = gcData.gift_card?.balance_money?.amount;
    if (typeof balance !== "number" || balance <= 0) {
      return NextResponse.json(
        { error: "Gift card has no balance to refund" },
        { status: 400 },
      );
    }
    refundAmountCents = balance;
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Gift card lookup failed";
    return NextResponse.json({ error: msg }, { status: 502 });
  }

  // ── 2. Refund the deposit payment ─────────────────────────────────────────
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
    return NextResponse.json({ error: detail, code }, { status: refundRes.status });
  }

  const refundId      = refundData.refund!.id;
  const refundedCents = refundData.refund!.amount_money?.amount ?? refundAmountCents;

  // ── 3. Cancel day-of order ────────────────────────────────────────────────
  // Non-fatal: if the order was already redeemed by staff, skip gracefully.
  let dayofOrderCancelled = false;

  if (dayofOrderId) {
    try {
      const getRes = await fetch(`${SQUARE_BASE}/orders/${dayofOrderId}`, {
        headers: sqHeaders(),
      });
      if (getRes.ok) {
        const getJson = (await getRes.json()) as {
          order?: { version?: number; state?: string };
        };
        const currentVersion = getJson.order?.version ?? 1;
        const currentState   = getJson.order?.state;

        if (currentState !== "CANCELED" && currentState !== "COMPLETED") {
          const cancelRes = await fetch(`${SQUARE_BASE}/orders/${dayofOrderId}`, {
            method: "PUT",
            headers: sqHeaders(),
            body: JSON.stringify({
              order: {
                location_id: locationId,
                version: currentVersion,
                state: "CANCELED",
              },
              idempotency_key: `${idempotencyKey}-cancel`,
            }),
          });
          if (cancelRes.ok) dayofOrderCancelled = true;
        } else {
          // Already in a terminal state — treat as cancelled
          dayofOrderCancelled = true;
        }
      }
    } catch {
      // Non-fatal
    }
  }

  // ── 4. Deactivate the gift card ───────────────────────────────────────────
  // Prevents the GAN from being reused. Non-fatal — refund has already landed.
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
          deactivate_activity_details: {
            reason: "CHARGEBACK_DEACTIVATED",
          },
        },
      }),
    });
    if (deactivateRes.ok) giftCardDeactivated = true;
  } catch {
    // Non-fatal
  }

  return NextResponse.json({ refundId, refundedCents, dayofOrderCancelled, giftCardDeactivated });
}
