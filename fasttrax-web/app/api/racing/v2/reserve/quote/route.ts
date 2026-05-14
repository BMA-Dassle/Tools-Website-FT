import { NextRequest, NextResponse } from "next/server";
import { syncBmiToSquareOrder } from "@/lib/square-deposit-order";
import {
  ALLOWED_BMI_CLIENTS,
  LOCATION_TO_BMI_CLIENT,
} from "@/lib/bmi-client";

/**
 * POST /api/racing/v2/reserve/quote
 *
 * Light version of the racing reserve — reads BMI bill/overview for
 * authoritative pricing and creates a Square quote order (no payment,
 * no Neon insert). Used by the review step to show the exact
 * charge including tax, credits, and discounts.
 *
 * Returns dayofOrderId so the subsequent reserve call can reuse it.
 */

const LOCATION_TO_SQUARE: Record<string, string> = {
  fasttrax: "LAB52GY480CJF",
  headpinz: "TXBSQN0FEKQ11",
  naples: "PPTR5G2N0QXF7",
};

interface QuoteBody {
  locationKey: string;
  bmiBillId: string;
  clientKey?: string;
  squareCustomerId?: string;
  racerType?: "new" | "returning";
  racerCount?: number;
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as QuoteBody;
    const { locationKey, bmiBillId } = body;

    if (!locationKey || !LOCATION_TO_SQUARE[locationKey]) {
      return NextResponse.json(
        { error: `Invalid location: ${locationKey}` },
        { status: 400 },
      );
    }
    if (!bmiBillId || typeof bmiBillId !== "string") {
      return NextResponse.json(
        { error: "bmiBillId required (as string)" },
        { status: 400 },
      );
    }

    const squareLocationId = LOCATION_TO_SQUARE[locationKey];
    const bmiClientKey = body.clientKey || LOCATION_TO_BMI_CLIENT[locationKey] || "headpinzftmyers";
    if (!ALLOWED_BMI_CLIENTS.has(bmiClientKey)) {
      return NextResponse.json({ error: "Invalid BMI client" }, { status: 400 });
    }

    const metadata: Record<string, string> = {
      bmi_bill_id: bmiBillId,
      attraction: "racing",
    };
    if (body.racerType) metadata.booking_type = body.racerType;
    if (body.racerCount) metadata.racer_count = String(body.racerCount);

    const result = await syncBmiToSquareOrder({
      bmiBillId,
      bmiClientKey,
      locationId: squareLocationId,
      note: "Racing quote",
      metadata,
      squareCustomerId: body.squareCustomerId,
    });

    return NextResponse.json({
      cashOwedCents: result.cashOwedCents,
      cashSubtotalCents: result.cashSubtotalCents,
      cashTaxCents: result.cashTaxCents,
      creditAppliedCents: result.creditAppliedCents,
      bmiTotalCents: result.bmiTotalCents,
      lineItems: result.lineItems,
      isCreditOnly: result.isCreditOnly,
      isZeroDollar: result.isZeroDollar,
      dayofOrderId: result.dayofOrderId ?? null,
      dayofOrderVersion: result.dayofOrderVersion ?? null,
    });
  } catch (err) {
    console.error("[racing/v2/reserve/quote] Error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Quote failed" },
      { status: 500 },
    );
  }
}
