import { NextRequest, NextResponse } from "next/server";
import {
  listSyncQueueForAdmin,
  listRecentGuestAdds,
  listWaiverPushesForAdmin,
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

  /**
   * The queue alone answers "what is stuck". Guests whose attach + waiver landed
   * first time produce NO queue rows, so they would be invisible — and "did my
   * person get added?" is the question this panel exists for. So the feed is the
   * union, newest first, with anything needing attention floated up.
   */
  /**
   * THREE sources now, not two. Waiver pushes that ride Vercel Queues have no
   * `bmi_sync_queue` row — the message lives in a topic the board cannot query —
   * so without this they would silently disappear from the panel the moment the
   * new transport took over. Each row carries `transport` so the panel can say
   * which mechanism is behind (owner 2026-08-13).
   */
  const [queueRows, guestAdds, waiverPushes, stateMap] = await Promise.all([
    listSyncQueueForAdmin({ limit, includeDone }),
    listRecentGuestAdds(),
    listWaiverPushesForAdmin({ limit, includeDone }),
    refs.length > 0 ? syncStateForReservations(refs) : Promise.resolve(new Map()),
  ]);
  const rank = (s: string) => (s === "parked" ? 0 : s === "pending" ? 1 : 2);
  const rows = [...queueRows, ...guestAdds, ...waiverPushes].sort(
    (a, b) => rank(a.status) - rank(b.status) || Date.parse(b.createdAt) - Date.parse(a.createdAt),
  );

  return NextResponse.json({
    ok: true,
    rows,
    // Object rather than Map for JSON; the board rebuilds a lookup.
    byReservation: Object.fromEntries(stateMap),
  });
}
