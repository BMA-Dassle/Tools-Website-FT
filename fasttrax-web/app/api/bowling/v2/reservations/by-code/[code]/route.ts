import { NextRequest, NextResponse } from "next/server";
import { getBowlingReservationByShortCode } from "@/lib/bowling-db";

/**
 * GET /api/bowling/v2/reservations/by-code/[code]
 *
 * Resolves a short_code (the 6-char random code from /s/{code} URLs)
 * to a full reservation with line items. Used by the confirmation page
 * so the sequential Neon ID never appears in the browser URL.
 *
 * Returns the same shape as GET /api/bowling/v2/reservations/[id].
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
    return NextResponse.json(reservation);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
