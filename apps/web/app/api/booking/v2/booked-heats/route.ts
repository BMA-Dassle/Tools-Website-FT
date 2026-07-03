import { NextRequest, NextResponse } from "next/server";
import { raceHeatsForPersonsOnDate } from "@/lib/bowling-db";

/**
 * GET /api/booking/v2/booked-heats?date=YYYY-MM-DD&personIds=1,2[&excludeBillId=...]
 *
 * Heats already booked (active reservations) by the given racers on a date —
 * the heat picker greys out slots that would violate the spacing rules against
 * a racer's EXISTING reservation, mirroring the authoritative reserve-time
 * guard (cross-reservation spacing; conflict.ts findCrossBookingConflict).
 * Returns heat start/track/personId only — no reservation details. Fail-open:
 * on a query error the picker just doesn't grey (the reserve guard still runs).
 */
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const date = sp.get("date") ?? "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return NextResponse.json({ error: "date must be YYYY-MM-DD" }, { status: 400 });
  }
  const personIds = (sp.get("personIds") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^\d{1,20}$/.test(s))
    .slice(0, 16);
  if (personIds.length === 0) return NextResponse.json({ heats: [] });
  const rawExclude = sp.get("excludeBillId") ?? "";
  const excludeBillId = /^\d{1,20}$/.test(rawExclude) ? rawExclude : null;
  try {
    const heats = await raceHeatsForPersonsOnDate({ date, personIds, excludeBillId });
    return NextResponse.json({
      heats: heats.map((h) => ({ heatId: h.heatId, track: h.track, bmiPersonId: h.bmiPersonId })),
    });
  } catch (err) {
    console.error("[booked-heats] query failed (failing open):", err);
    return NextResponse.json({ heats: [] });
  }
}
