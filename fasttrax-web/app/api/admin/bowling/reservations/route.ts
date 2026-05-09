import { NextRequest, NextResponse } from "next/server";
import { listBowlingReservations } from "@/lib/bowling-db";

/**
 * GET /api/admin/bowling/reservations?token=...&date=YYYY-MM-DD&center=...
 *
 * Returns all bowling reservations for the given date.
 * Auth: ADMIN_CAMERA_TOKEN query param.
 */
export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const token = searchParams.get("token") ?? "";
  const expected = process.env.ADMIN_CAMERA_TOKEN || "";
  if (!expected || token !== expected) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const date = searchParams.get("date");
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return NextResponse.json(
      { error: "date param required (YYYY-MM-DD)" },
      { status: 400 },
    );
  }

  const center = searchParams.get("center") || undefined;

  try {
    const reservations = await listBowlingReservations({
      startDate: date,
      endDate: date,
      centerCode: center,
    });
    return NextResponse.json({ reservations });
  } catch (err) {
    console.error("[admin/bowling/reservations]", err);
    return NextResponse.json(
      { error: "Failed to load reservations" },
      { status: 500 },
    );
  }
}
