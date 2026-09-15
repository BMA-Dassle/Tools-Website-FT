import { NextRequest, NextResponse } from "next/server";
import { simSlotCircuitLocks } from "@/lib/bowling-db";

/**
 * GET /api/booking/v2/sim-slot-circuits?date=YYYY-MM-DD[&excludeBillId=...]
 *
 * Which Race Sim time slots on a date are already locked to a track key (and
 * so to a circuit). Four rigs share one capacity pool, so a session runs ONE
 * circuit: the first booking on a slot fixes it, and the schedule shows later
 * guests the circuit already running instead of an open picker.
 *
 * Returns slot + trackKey only — no reservation details, no guest data — so it
 * needs no auth, exactly like /booked-heats next door.
 *
 * FAIL-OPEN on error: an empty list just means the schedule offers every
 * circuit, and guard 2f still refuses a clashing pick at reserve BEFORE any
 * Square write. The grid is a convenience; the guard is the rule.
 */
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const date = sp.get("date") ?? "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return NextResponse.json({ error: "date must be YYYY-MM-DD" }, { status: 400 });
  }
  const rawExclude = sp.get("excludeBillId") ?? "";
  const excludeBillId = /^\d{1,20}$/.test(rawExclude) ? rawExclude : null;
  try {
    const locks = await simSlotCircuitLocks({ date, excludeBillId });
    return NextResponse.json({ locks });
  } catch (err) {
    console.error("[sim-slot-circuits] query failed (failing open):", err);
    return NextResponse.json({ locks: [] });
  }
}
