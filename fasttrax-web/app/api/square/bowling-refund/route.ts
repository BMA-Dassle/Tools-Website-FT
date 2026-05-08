import { NextRequest, NextResponse } from "next/server";

/**
 * POST /api/square/bowling-refund
 *
 * Handles the Square side of cancelling a paid bowling booking:
 *   1. Refunds the deposit payment in full via Square /v2/refunds
 *   2. Cancels the day-of order (moves it to CANCELED state)
 *
 * Both operations are best-effort — the caller (DELETE /api/bowling/v2/reservations/[id])
 * decides whether to surface errors or proceed with Neon cancellation anyway.
 *
 * Request body:
 * {
 *   depositPaymentId: string   — Square payment ID to refund
 *   depositOrderId:   string   — Square deposit order ID
 *   dayofOrderId?:    string   — Square day-of order ID (cancel it)
 *   amountCents:      number   — amount to refund (must match original charge)
 *   locationId:       string   — Square location ID
 *   idempotencyKey:   string   — UUID for dedup
 * }
 *
 * Response (200):
 * {
 *   refundId:             string
 *   refundedCents:        number
 *   dayofOrderCancelled:  boolean
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
  depositOrderId: string;
  dayofOrderId?: string;
  amountCents: number;
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

  const { depositPaymentId, depositOrderId, dayofOrderId, amountCents, locationId, idempotencyKey } = body;

  if (!depositPaymentId || !depositOrderId || !amountCents || !locationId || !idempotencyKey) {
    return NextResponse.json({ error: "depositPaymentId, depositOrderId, amountCents, locationId, idempotencyKey are required" }, { status: 400 });
  }

  // ── 1. Refund the deposit payment ────────────────────────────────────────
  const refundRes = await fetch(`${SQUARE_BASE}/refunds`, {
    method: "POST",
    headers: sqHeaders(),
    body: JSON.stringify({
      idempotency_key: idempotencyKey,
      payment_id: depositPaymentId,
      amount_money: { amount: amountCents, currency: "USD" },
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
  const refundedCents = refundData.refund!.amount_money?.amount ?? amountCents;

  // ── 2. Cancel day-of order ────────────────────────────────────────────────
  // Square requires the current order version before updating state.
  // Non-fatal: if the order can't be cancelled (e.g. already redeemed),
  // we still surface the refund success.
  let dayofOrderCancelled = false;

  if (dayofOrderId) {
    try {
      // Fetch current order version
      const getRes = await fetch(`${SQUARE_BASE}/orders/${dayofOrderId}`, {
        headers: sqHeaders(),
      });
      if (getRes.ok) {
        const getJson = (await getRes.json()) as { order?: { version?: number; state?: string } };
        const currentVersion = getJson.order?.version ?? 1;
        const currentState   = getJson.order?.state;

        // Only cancel if not already in a terminal state
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
          // Already in terminal state — treat as cancelled
          dayofOrderCancelled = true;
        }
      }
    } catch {
      // Non-fatal — day-of order cancel failure doesn't block the refund
    }
  }

  return NextResponse.json({ refundId, refundedCents, dayofOrderCancelled });
}
