import { NextRequest, NextResponse } from "next/server";
import { listWebOffers } from "@/lib/qamf-bowling";

/**
 * GET /api/bowling/v2/offers
 *
 * Returns all web offers for a center from the QAMF Internal API.
 * The wizard uses this to populate the offer/game-type selection step.
 *
 * Query params:
 *   centerId — QAMF center ID (required)
 */
export async function GET(req: NextRequest) {
  const centerIdStr = req.nextUrl.searchParams.get("centerId");
  if (!centerIdStr) {
    return NextResponse.json({ error: "centerId required" }, { status: 400 });
  }

  const centerId = parseInt(centerIdStr, 10);
  if (isNaN(centerId)) {
    return NextResponse.json({ error: "invalid centerId" }, { status: 400 });
  }

  try {
    const offers = await listWebOffers(centerId);
    return NextResponse.json(offers);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
