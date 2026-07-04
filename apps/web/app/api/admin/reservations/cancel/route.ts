import { NextRequest, NextResponse } from "next/server";
import { CancelGuardError, cancelReservationCascade } from "~/features/cancellation";

/**
 * POST /api/admin/reservations/cancel?token=...
 *
 * Staff cancel for EVERY reservation kind — bowling, race, attraction,
 * bowling+add-ons, and Ultimate VIP combos (both legs resolve from any leg's
 * neonId). Two outcomes:
 *   "refund"       — full deposit back to the original card(s)
 *   "store_credit" — deposit converted to a NEW Square-GAN gift card
 *                    (emailed+texted to the guest unless notifyGuest=false —
 *                    staff keep the GAN for phone rebooks)
 *
 * Body: {
 *   neonId: number,
 *   outcome: "refund" | "store_credit",
 *   dryRun?: boolean,          // returns the step plan without mutating —
 *                              // the modal renders this as its preview
 *   notifyGuest?: boolean,     // store_credit only; default true
 *   resumeTeardown?: boolean,  // re-run best-effort teardown of a committed cancel
 * }
 *
 * Auth: ADMIN_CAMERA_TOKEN query param (portal convention).
 */
export async function POST(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token") ?? "";
  const expected = process.env.ADMIN_CAMERA_TOKEN || "";
  if (!expected || token !== expected) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: {
    neonId?: unknown;
    outcome?: unknown;
    dryRun?: unknown;
    notifyGuest?: unknown;
    resumeTeardown?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const neonId = typeof body.neonId === "number" ? body.neonId : parseInt(String(body.neonId), 10);
  if (!neonId || Number.isNaN(neonId)) {
    return NextResponse.json({ error: "neonId required" }, { status: 400 });
  }
  const outcome = body.outcome === "store_credit" ? "store_credit" : "refund";

  try {
    const result = await cancelReservationCascade({
      neonId,
      outcome,
      actor: "admin",
      dryRun: body.dryRun === true,
      notifyGuest: body.notifyGuest !== false,
      resumeTeardown: body.resumeTeardown === true,
      allowCustomerRefund: true,
    });
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof CancelGuardError) {
      return NextResponse.json(
        { error: err.code, detail: err.message },
        { status: err.httpStatus },
      );
    }
    const msg = err instanceof Error ? err.message : "unknown error";
    console.error(`[admin/reservations/cancel] neonId=${neonId} failed:`, msg);
    return NextResponse.json({ error: "cancel_failed", detail: msg }, { status: 502 });
  }
}
