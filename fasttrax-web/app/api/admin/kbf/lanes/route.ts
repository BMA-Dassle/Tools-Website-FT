import { NextRequest, NextResponse } from "next/server";
import { listLanes } from "@/lib/qamf-bowling";

/**
 * GET /api/admin/kbf/lanes?centerId=9172
 *
 * Returns lane statuses from QAMF for a center.
 * Valid center IDs: 9172 (Fort Myers), 3148 (Naples).
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const centerId = Number(url.searchParams.get("centerId"));

  if (!centerId || ![9172, 3148].includes(centerId)) {
    return NextResponse.json({ error: "Invalid centerId" }, { status: 400 });
  }

  try {
    const lanes = await listLanes(centerId);
    return NextResponse.json({ lanes });
  } catch (err) {
    const msg =
      err instanceof Error ? err.message : "Failed to fetch lanes";
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
