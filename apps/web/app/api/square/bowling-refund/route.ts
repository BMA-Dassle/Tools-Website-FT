import { NextRequest, NextResponse } from "next/server";
import { processSquareBowlingRefund } from "@/lib/square-bowling-refund";

/**
 * POST /api/square/bowling-refund?token=...
 *
 * HTTP wrapper around lib/square-bowling-refund.ts.
 * Core logic lives in the shared lib so the QAMF webhook consumer can
 * call it directly without going through fetch.
 *
 * Auth: ADMIN_CAMERA_TOKEN query param (portal convention). This endpoint
 * MOVES MONEY from ids supplied in the request body and shipped
 * unauthenticated; anyone who could reach it and knew (or guessed) a payment
 * + gift-card id pair could issue Square refunds. In-process callers (the
 * QAMF webhook consumer, the cancellation cascade) import the lib directly
 * and are unaffected by this gate.
 *
 * Request body:
 * {
 *   depositPaymentId: string
 *   depositOrderId?:  string  // Required for multi-tender (split GC+card) refunds
 *   giftCardId:       string
 *   dayofOrderId?:    string
 *   locationId:       string
 *   idempotencyKey:   string
 * }
 */
export async function POST(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token") ?? "";
  const expected = process.env.ADMIN_CAMERA_TOKEN || "";
  if (!expected || token !== expected) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: {
    depositPaymentId?: string;
    depositOrderId?: string;
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

  const { depositPaymentId, depositOrderId, giftCardId, dayofOrderId, locationId, idempotencyKey } =
    body;

  if (!depositPaymentId || !giftCardId || !locationId || !idempotencyKey) {
    return NextResponse.json(
      { error: "depositPaymentId, giftCardId, locationId, idempotencyKey are required" },
      { status: 400 },
    );
  }

  try {
    const result = await processSquareBowlingRefund({
      depositPaymentId,
      depositOrderId,
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
