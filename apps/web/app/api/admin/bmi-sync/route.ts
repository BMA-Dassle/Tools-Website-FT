import { NextRequest, NextResponse } from "next/server";
import {
  listSyncQueueForAdmin,
  syncStateForReservations,
} from "~/features/reservations-admin/bmi-sync-view";

/**
 * GET /api/admin/bmi-sync?token=…&refs=bill1,bill2,…
 *
 * Feeds two things on the reservations board (owner 2026-08-12): the "BMI sync"
 * panel (everything in bmi_sync_queue) and the per-reservation "On-site" pill.
 *
 * Both come from one request because the board renders them together and a
 * per-reservation call would be an N+1 on a page staff keep open all day.
 *
 * `refs` are BMI bill ids / W-numbers — whatever the board knows for the
 * reservations currently on screen. Read-only; never throws (the board must
 * render even when the queue is unreachable).
 */

export const dynamic = "force-dynamic";

const MAX_REFS = 400;

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const expected = process.env.ADMIN_CAMERA_TOKEN || "";
  if (!expected || sp.get("token") !== expected) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const refs = (sp.get("refs") || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, MAX_REFS);
  const includeDone = sp.get("includeDone") !== "0";
  const limit = Number(sp.get("limit") || "200");

  const [rows, stateMap] = await Promise.all([
    listSyncQueueForAdmin({ limit, includeDone }),
    refs.length > 0 ? syncStateForReservations(refs) : Promise.resolve(new Map()),
  ]);

  return NextResponse.json({
    ok: true,
    rows,
    // Object rather than Map for JSON; the board rebuilds a lookup.
    byReservation: Object.fromEntries(stateMap),
  });
}
