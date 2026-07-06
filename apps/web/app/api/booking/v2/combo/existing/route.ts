import { NextRequest, NextResponse } from "next/server";
import { listComboGroupsForDate } from "~/features/combos/combo-existing.server";
import { getComboSpecial } from "~/features/combos/combo-specials";

/**
 * GET /api/booking/v2/combo/existing?date=YYYY-MM-DD&comboId=race-bowl
 *
 * The date's already-booked VIP combo groups (anchor heat, start hour, track,
 * bowling start, party size — NO PII), so the combo wizard can steer a second
 * booking onto the same schedule and staff can walk both groups over together.
 * Fail-open: ANY problem returns { groups: [] } with 200 — the hint must
 * never break the booking wizard.
 */
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const date = sp.get("date") ?? "";
  const comboId = sp.get("comboId") ?? "";
  const headers = { "cache-control": "no-store" };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !getComboSpecial(comboId)) {
    return NextResponse.json({ groups: [] }, { headers });
  }
  try {
    const groups = await listComboGroupsForDate({ dateYmd: date, comboSpecialId: comboId });
    return NextResponse.json({ groups }, { headers });
  } catch (err) {
    console.error("[combo-existing] query failed (failing open):", err);
    return NextResponse.json({ groups: [] }, { headers });
  }
}
