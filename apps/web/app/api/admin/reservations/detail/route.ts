import { NextRequest, NextResponse } from "next/server";
import { detailQuerySchema } from "~/features/reservations-admin/schemas";
import { getReservationDetail } from "~/features/reservations-admin/service";

/**
 * GET /api/admin/reservations/detail?token=…&id=<neonId>
 *                                  (or &billId=<BMI bill id — string>)
 *
 * Eager payload for the Manage Reservation modal: the full Neon row + lines,
 * the money group (every leg sharing the deposit order — combo legs, mixed
 * carts), and the merged action/cancel history. Deliberately NO live
 * Square/BMI/QAMF reads — the Payments tab fetches those separately.
 *
 * Auth: ADMIN_CAMERA_TOKEN query param (portal convention).
 */
export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token") ?? "";
  const expected = process.env.ADMIN_CAMERA_TOKEN || "";
  if (!expected || token !== expected) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const parsed = detailQuerySchema.safeParse({
    id: req.nextUrl.searchParams.get("id") ?? undefined,
    billId: req.nextUrl.searchParams.get("billId") ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "bad query" },
      {
        status: 400,
      },
    );
  }

  try {
    const detail = await getReservationDetail(parsed.data);
    if (!detail) {
      return NextResponse.json({ error: "reservation not found" }, { status: 404 });
    }
    return NextResponse.json(detail);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    console.error(`[admin/reservations/detail]`, msg);
    return NextResponse.json({ error: "detail_failed", detail: msg }, { status: 500 });
  }
}
