import { after, NextRequest, NextResponse } from "next/server";
import {
  listSyncQueueForAdmin,
  listRecentGuestAdds,
  listWaiverPushesForAdmin,
  syncStateForReservations,
} from "~/features/reservations-admin/bmi-sync-view";
import {
  cachedWaiverCoverage,
  refreshWaiverCoverage,
} from "~/features/reservations-admin/waiver-coverage.server";

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
/**
 * The RESPONSE is four Neon reads and lands in ~200ms. This ceiling is for the
 * `after()` work that follows it — the Pandora coverage refresh, which is
 * deliberately allowed to be slow because nobody is waiting on it.
 */
export const maxDuration = 60;

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
   *
   * THREE sources now, not two. Waiver pushes that ride Vercel Queues have no
   * `bmi_sync_queue` row — the message lives in a topic the board cannot query —
   * so without this they would silently disappear from the panel the moment the
   * new transport took over. Each row carries `transport` so the panel can say
   * which mechanism is behind (owner 2026-08-13).
   *
   * NOTHING HERE WAITS ON PANDORA (2026-08-18).
   *
   * The guest-add rows want one more fact than Neon holds — whether BMI already
   * holds a waiver for a guest who never signed through us — and that fact used
   * to be fetched live, inline, five people at a time. Measured on the day
   * Pandora started dropping ~half of all requests into a 30s+ hang, that phase
   * alone took 26.8s and 29.5s on consecutive runs, against a panel the board
   * re-polls every 20 seconds. The modal showed "Nothing to show" the whole time
   * — not because nothing was wrong, but because the rows had not arrived.
   *
   * So the coverage answer is read from cache (one Redis MGET) and the live read
   * is scheduled with `after()`, below. Cache cold means a row says "checking
   * BMI for an existing waiver" for one poll instead of the page taking half a
   * minute. Twenty seconds of accuracy is the right thing to trade; the operator
   * looking at a blank panel is not.
   */
  const [queueRows, guestAdds, waiverPushes, stateMap] = await Promise.all([
    listSyncQueueForAdmin({ limit, includeDone }),
    listRecentGuestAdds({ coverage: cachedWaiverCoverage }),
    listWaiverPushesForAdmin({ limit, includeDone }),
    refs.length > 0 ? syncStateForReservations(refs) : Promise.resolve(new Map()),
  ]);
  const rank = (s: string) => (s === "parked" ? 0 : s === "pending" ? 1 : 2);
  const rows = [...queueRows, ...guestAdds.rows, ...waiverPushes].sort(
    (a, b) => rank(a.status) - rank(b.status) || Date.parse(b.createdAt) - Date.parse(a.createdAt),
  );

  // After the response. A hang here costs the operator nothing; the next poll,
  // 20s later, reads whatever this managed to learn.
  if (guestAdds.unresolved.length > 0) {
    after(() => refreshWaiverCoverage(guestAdds.unresolved));
  }

  return NextResponse.json({
    ok: true,
    rows,
    // Object rather than Map for JSON; the board rebuilds a lookup.
    byReservation: Object.fromEntries(stateMap),
  });
}
