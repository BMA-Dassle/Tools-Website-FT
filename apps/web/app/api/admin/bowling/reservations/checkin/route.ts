import { NextRequest, NextResponse } from "next/server";
import { updateBowlingCheckinMethod } from "@/lib/bowling-db";

/**
 * POST /api/admin/bowling/reservations/checkin?token=...
 * Body: { neonId: number, method: "self" | "desk" | null }
 *
 * Sets the check-in method on a bowling reservation (admin action).
 * Pass null to clear.
 */
export async function POST(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token") ?? "";
  const expected = process.env.ADMIN_CAMERA_TOKEN || "";
  if (!expected || token !== expected) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    const { neonId, method } = await req.json();
    if (!neonId || (method !== "self" && method !== "desk" && method !== null)) {
      return NextResponse.json(
        { error: "neonId required, method must be 'self', 'desk', or null" },
        { status: 400 },
      );
    }

    await updateBowlingCheckinMethod(neonId, method);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[admin/bowling/checkin]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed" },
      { status: 500 },
    );
  }
}
