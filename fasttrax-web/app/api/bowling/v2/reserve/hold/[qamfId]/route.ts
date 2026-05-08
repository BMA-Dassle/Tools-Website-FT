import { NextRequest, NextResponse } from "next/server";
import { extendReservation, deleteReservation } from "@/lib/qamf-bowling";

/**
 * PATCH /api/bowling/v2/reserve/hold/[qamfId]
 *   Extends the QAMF Temporary hold by +10 min.
 *   Called every ~8 min by the wizard's keep-alive timer.
 *   Body: { centerId: number }
 *
 * DELETE /api/bowling/v2/reserve/hold/[qamfId]
 *   Releases (deletes) the QAMF Temporary hold.
 *   Called when the user navigates back to the offer step or abandons the wizard.
 *   Always returns 200 — QAMF 404s are silently swallowed (hold may have expired).
 *   Body: { centerId: number }
 */

interface HoldActionBody {
  centerId: number;
}

type Context = { params: Promise<{ qamfId: string }> };

export async function PATCH(req: NextRequest, ctx: Context) {
  const { qamfId } = await ctx.params;

  let body: HoldActionBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const { centerId } = body;
  if (!centerId) {
    return NextResponse.json({ error: "centerId required" }, { status: 400 });
  }

  try {
    await extendReservation(centerId, qamfId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "extend failed";
    console.error(`[bowling/v2/reserve/hold/${qamfId}] PATCH error:`, msg);
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}

export async function DELETE(req: NextRequest, ctx: Context) {
  const { qamfId } = await ctx.params;

  let body: HoldActionBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const { centerId } = body;
  if (!centerId) {
    return NextResponse.json({ error: "centerId required" }, { status: 400 });
  }

  try {
    await deleteReservation(centerId, qamfId);
  } catch {
    // Swallow — hold may have already expired or been released
  }

  return NextResponse.json({ ok: true });
}
