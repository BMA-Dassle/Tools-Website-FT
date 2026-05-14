import { NextRequest, NextResponse } from "next/server";
import {
  createQuoteOrder,
  DepositOrderError,
  type LineItemInput,
} from "@/lib/square-deposit-order";

/**
 * POST /api/attractions/v2/reserve/quote
 *
 * Creates a Square day-of order (no payment) and returns the tax-inclusive
 * total + computed deposit amount for an attraction booking.
 *
 * Used by the review step so the UI shows the exact charge (including
 * county sales tax) before the customer enters their card.
 */

const LOCATION_TO_SQUARE: Record<string, string> = {
  fasttrax: "LAB52GY480CJF",
  headpinz: "TXBSQN0FEKQ11",
  naples: "PPTR5G2N0QXF7",
};

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      locationKey: string;
      lineItems: LineItemInput[];
      depositPct?: number;
      squareCustomerId?: string;
    };

    const { locationKey, lineItems } = body;
    const squareLocationId = LOCATION_TO_SQUARE[locationKey];

    if (!squareLocationId || !lineItems?.length) {
      return NextResponse.json(
        { error: "locationKey and lineItems required" },
        { status: 400 },
      );
    }

    const result = await createQuoteOrder({
      locationId: squareLocationId,
      lineItems: body.lineItems,
      depositPct: body.depositPct,
      squareCustomerId: body.squareCustomerId,
    });

    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof DepositOrderError) {
      return NextResponse.json({ error: err.userMessage }, { status: err.statusCode });
    }
    const msg = err instanceof Error ? err.message : "unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
