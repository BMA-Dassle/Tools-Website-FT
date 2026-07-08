import { NextRequest, NextResponse } from "next/server";
import { CancelGuardError, cancelReservationCascade } from "~/features/cancellation";

// Refund + teardown + BMI state verification (Pandora writes can take ~25s to
// become visible) can exceed the default function window.
export const maxDuration = 60;

/**
 * POST /api/admin/bowling/reservations/cancel?token=...
 *
 * LEGACY admin cancel (the portal's original refund-only button + the KBF
 * admin board). Now a thin shell over the cancellation cascade — which means
 * combo legs cancel BOTH legs correctly (refund once, drain the shared gift
 * card, cancel both day-of orders, QAMF + BMI) instead of orphaning the race
 * leg. New admin work should use /api/admin/reservations/cancel, which also
 * offers the store-credit outcome + dry-run preview.
 *
 * Body: { neonId: number }   Response: { ok, refundCents } (contract kept)
 * Auth: ADMIN_CAMERA_TOKEN query param.
 */
export async function POST(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token") ?? "";
  const expected = process.env.ADMIN_CAMERA_TOKEN || "";
  if (!expected || token !== expected) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  const { neonId } = body as { neonId: number };
  if (!neonId) {
    return NextResponse.json({ error: "neonId required" }, { status: 400 });
  }

  try {
    const result = await cancelReservationCascade({
      neonId,
      outcome: "refund",
      actor: "admin",
      dryRun: false,
      allowCustomerRefund: true,
    });
    if (result.alreadyCancelled) {
      return NextResponse.json({ error: "Already cancelled" }, { status: 409 });
    }
    return NextResponse.json({ ok: true, refundCents: result.refundCents ?? 0 });
  } catch (err) {
    if (err instanceof CancelGuardError) {
      if (err.code === "not_found") {
        return NextResponse.json({ error: "Reservation not found" }, { status: 404 });
      }
      return NextResponse.json({ error: err.message }, { status: err.httpStatus });
    }
    const msg = err instanceof Error ? err.message : "unknown error";
    console.error(`[admin/bowling/cancel] neonId=${neonId} failed:`, msg);
    return NextResponse.json(
      { error: "Refund failed — try again or issue manual refund in Square." },
      { status: 502 },
    );
  }
}
