import { NextRequest, NextResponse } from "next/server";
import {
  createDepositOrder,
  DepositOrderError,
  type LineItemInput,
} from "@/lib/square-deposit-order";

/**
 * POST /api/square/bowling-orders
 *
 * Thin wrapper around the shared deposit layer (lib/square-deposit-order.ts).
 * Creates Square orders + payment for a bowling booking via the 5-step
 * deposit gift card pattern.
 *
 * See square-deposit-order.ts for the full flow documentation.
 */

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      sourceId: string;
      idempotencyKey?: string;
      locationId: string;
      depositPct?: number;
      lineItems?: LineItemInput[];
      squareCustomerId?: string;
      note?: string;
      giftCardGan?: string;
      existingDayofOrderId?: string;
      existingDayofTotalCents?: number;
      existingDepositCents?: number;
    };

    const { sourceId, locationId } = body;
    const depositPct = body.depositPct ?? 100;

    if (!sourceId || !locationId) {
      return NextResponse.json({ error: "sourceId and locationId required" }, { status: 400 });
    }
    if (!body.lineItems?.length && !body.existingDayofOrderId) {
      return NextResponse.json({ error: "lineItems required" }, { status: 400 });
    }
    if (depositPct < 0 || depositPct > 100) {
      return NextResponse.json({ error: "depositPct must be 0–100" }, { status: 400 });
    }

    const result = await createDepositOrder({
      sourceId: body.sourceId,
      idempotencyKey: body.idempotencyKey,
      locationId: body.locationId,
      depositPct: body.depositPct,
      lineItems: body.lineItems,
      squareCustomerId: body.squareCustomerId,
      note: body.note,
      giftCardGan: body.giftCardGan,
      existingDayofOrderId: body.existingDayofOrderId,
      existingDayofTotalCents: body.existingDayofTotalCents,
      existingDepositCents: body.existingDepositCents,
      depositLineName: "Bowling Reservation Deposit",
    });

    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof DepositOrderError) {
      const response: Record<string, unknown> = { error: err.userMessage };
      if (err.code) response.code = err.code;
      if (err.detail) response.detail = err.detail;
      return NextResponse.json(response, { status: err.statusCode });
    }
    const msg = err instanceof Error ? err.message : "unknown error";
    console.error("[square/bowling-orders] unexpected error:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
