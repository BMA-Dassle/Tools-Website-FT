import { NextRequest, NextResponse } from "next/server";
import { extendReservation, deleteReservation, patchReservation } from "@/lib/qamf-bowling";

/**
 * PATCH /api/bowling/v2/reserve/hold/[qamfId]
 *   Extends the QAMF Temporary hold by +10 min.
 *   Called every ~8 min by the wizard's keep-alive timer.
 *   Also accepts an optional `title` field — when provided the reservation
 *   title is updated alongside the extend (e.g. once the guest fills in
 *   their name on the details step, "Hold (2p)" becomes "Jane Smith (2p)").
 *   Body: { centerId: number; title?: string }
 *
 * DELETE /api/bowling/v2/reserve/hold/[qamfId]
 *   Releases (deletes) the QAMF Temporary hold.
 *   Called when the user navigates back to the offer step or abandons the wizard.
 *   Always returns 200 — QAMF 404s are silently swallowed (hold may have expired).
 *   Body: { centerId: number }
 */

interface PatchBody {
  centerId: number;
  title?: string;
}

interface DeleteBody {
  centerId: number;
}

type Context = { params: Promise<{ qamfId: string }> };

export async function PATCH(req: NextRequest, ctx: Context) {
  const { qamfId } = await ctx.params;

  let body: PatchBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const { centerId, title } = body;
  if (!centerId) {
    return NextResponse.json({ error: "centerId required" }, { status: 400 });
  }

  try {
    // Always extend the TTL
    await extendReservation(centerId, qamfId);

    // If a new title was provided (guest just confirmed their name), update it.
    // Fire-and-forget alongside the extend — non-fatal if QAMF doesn't support it.
    if (title) {
      await patchReservation(centerId, qamfId, { Title: title }).catch((err) => {
        console.warn(`[bowling/v2/reserve/hold/${qamfId}] title patch failed (non-fatal):`, err);
      });
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "extend failed";
    console.error(`[bowling/v2/reserve/hold/${qamfId}] PATCH error:`, msg);
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}

export async function DELETE(req: NextRequest, ctx: Context) {
  const { qamfId } = await ctx.params;

  let body: DeleteBody;
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
