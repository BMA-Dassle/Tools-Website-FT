import { NextRequest, NextResponse } from "next/server";
import { processSquareBowlingRefund } from "@/lib/square-bowling-refund";

/**
 * POST /api/square/bowling-refund
 *
 * HTTP wrapper around lib/square-bowling-refund.ts.
 * Core logic lives in the shared lib so the QAMF webhook consumer can
 * call it directly without going through fetch.
 *
 * Request body:
 * {
 *   depositPaymentId: string
 *   giftCardId:       string
 *   dayofOrderId?:    string
 *   locationId:       string
 *   idempotencyKey:   string
 * }
 */
export async function POST(req: NextRequest) {
  let body: {
    depositPaymentId?: string;
    giftCardId?: string;
    dayofOrderId?: string;
    locationId?: string;
    idempotencyKey?: string;
  };
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

  try {
    const result = await processSquareBowlingRefund({
      depositPaymentId,
      giftCardId,
      dayofOrderId,
      locationId,
      idempotencyKey,
    });
    return NextResponse.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Refund failed";
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
