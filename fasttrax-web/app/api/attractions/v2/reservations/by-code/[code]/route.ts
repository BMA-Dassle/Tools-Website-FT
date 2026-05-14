import { NextRequest, NextResponse } from "next/server";
import { getBowlingReservationByShortCode } from "@/lib/bowling-db";

/**
 * GET /api/attractions/v2/reservations/by-code/[code]
 *
 * Resolves a short_code to a full attraction reservation.
 * Identical to the bowling version — both live in bowling_reservations.
 */
export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ code: string }> },
) {
  const { code } = await ctx.params;
  if (!code || code.length < 4 || code.length > 12) {
    return NextResponse.json({ error: "invalid code" }, { status: 400 });
  }

  try {
    const reservation = await getBowlingReservationByShortCode(code);
    if (!reservation) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    // Verify this is actually an attraction reservation
    if (!reservation.attractionSlug) {
      return NextResponse.json({ error: "not an attraction reservation" }, { status: 404 });
    }
    return NextResponse.json(reservation);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
