import { NextRequest, NextResponse } from "next/server";
import { getBowlingReservation } from "@/lib/bowling-db";

/**
 * GET /api/bowling/v2/reservations/[id]
 *
 * Returns a single bowling reservation by Neon row ID, including line items.
 * Used by the confirmation pages to display booking details.
 *
 * Params:
 *   id — bowling_reservations.id (integer)
 */
export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: idStr } = await ctx.params;
  const id = parseInt(idStr, 10);
  if (isNaN(id) || id < 1) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }

  try {
    const reservation = await getBowlingReservation(id);
    if (!reservation) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    return NextResponse.json(reservation);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
