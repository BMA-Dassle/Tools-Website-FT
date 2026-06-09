import { NextRequest, NextResponse } from "next/server";
import { getBowlingReservationByQamfId } from "@/lib/bowling-db";

/**
 * GET /api/bowling/v2/reservations/by-qamf/[qamfId]
 *
 * Resolve a bowling reservation's Neon id (+ shortCode) from its
 * qamfReservationId. The v2 multi-activity confirmation page stores only the
 * qamfReservationId per bowling leg in the booking record; the player-details
 * editor needs the Neon id to call /reservations/[id]/players. Returns minimal,
 * non-sensitive fields only.
 */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ qamfId: string }> }) {
  const { qamfId } = await ctx.params;
  if (!qamfId) {
    return NextResponse.json({ error: "qamfId required" }, { status: 400 });
  }
  try {
    const reservation = await getBowlingReservationByQamfId(qamfId);
    if (!reservation) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    return NextResponse.json({
      id: reservation.id,
      shortCode: reservation.shortCode ?? null,
      playerCount: reservation.playerCount ?? null,
      status: reservation.status ?? null,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
