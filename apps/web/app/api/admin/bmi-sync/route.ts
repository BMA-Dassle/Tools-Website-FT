import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  countParkedBeforeWindow,
  listSyncQueueForAdmin,
  listRecentGuestAdds,
  listWaiverPushesForAdmin,
  syncStateForReservations,
} from "~/features/reservations-admin/bmi-sync-view";
import { dismissSyncRow } from "@/lib/bmi-sync-queue";
import { isAdminApiRequest } from "@/lib/admin-request-auth";

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
  if (!(await isAdminApiRequest(req, { token: sp.get("token") }))) {
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
  const [queueRows, guestAdds, waiverPushes, stateMap, olderParked] = await Promise.all([
    listSyncQueueForAdmin({ limit, includeDone }),
    listRecentGuestAdds(),
    listWaiverPushesForAdmin({ limit, includeDone }),
    refs.length > 0 ? syncStateForReservations(refs) : Promise.resolve(new Map()),
    countParkedBeforeWindow(),
  ]);
  const rank = (s: string) => (s === "parked" ? 0 : s === "pending" ? 1 : 2);
  const rows = [...queueRows, ...guestAdds, ...waiverPushes].sort(
    (a, b) => rank(a.status) - rank(b.status) || Date.parse(b.createdAt) - Date.parse(a.createdAt),
  );

  return NextResponse.json({
    ok: true,
    rows,
    // What the board's window is NOT showing. A quiet board must never be
    // mistaken for an empty one — see listSyncQueueForAdmin.
    olderParked,
    // Object rather than Map for JSON; the board rebuilds a lookup.
    byReservation: Object.fromEntries(stateMap),
  });
}

/**
 * POST — close a work order.
 *
 * The panel's rows are work orders (`parkSyncRow`), and until now nothing could
 * close one: the board could only ever accumulate. This is the first admin-side
 * write to `bmi_sync_queue`, so it is deliberately narrow.
 *
 * WHAT IT WILL NOT DO:
 *  - It will not touch a row that is not PARKED. A pending row is still being
 *    worked; burying it would hide live work. The guard is in the UPDATE's WHERE
 *    clause (`dismissSyncRow`), so two operators tapping at once cannot race.
 *  - It will not touch the waiver half of the board. Those rows live in a
 *    different table with its own dismiss rail, and `id` alone cannot tell the
 *    two apart — hence the required `source`.
 *  - It will not delete anything. A dismissed row keeps its history and the
 *    operator's reason, so it can still explain itself weeks later.
 *
 * The reason is REQUIRED. A row closed with no reason is indistinguishable from
 * one that was never looked at, which is how the board got into this state.
 */
const DismissSchema = z.object({
  action: z.literal("dismiss"),
  /** Which table `id` belongs to. Only queue rows are dismissible here. */
  source: z.literal("queue"),
  id: z.number().int().positive(),
  reason: z.string().trim().min(3).max(300),
  /** Who closed it, when the board knows. Free text; prefixed onto the reason. */
  by: z.string().trim().max(60).optional(),
});

export async function POST(req: NextRequest) {
  if (!(await isAdminApiRequest(req, { token: req.nextUrl.searchParams.get("token") }))) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const parsed = DismissSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: "bad_request", detail: parsed.error.issues[0]?.message },
      { status: 400 },
    );
  }

  const { id, reason, by } = parsed.data;
  try {
    const outcome = await dismissSyncRow(id, reason, by ?? null);
    if (outcome === "not-parked") {
      // Not an error the operator caused: the likeliest cause is that the row
      // resolved itself between the board's last poll and the tap, which is a
      // good outcome. Say which it was rather than a bare 409.
      return NextResponse.json(
        {
          ok: false,
          error: "not_parked",
          detail: "That row is no longer parked — reload the board.",
        },
        { status: 409 },
      );
    }
    console.log(`[admin/bmi-sync] row ${id} DISMISSED by ${by || "admin"}: ${reason}`);
    return NextResponse.json({ ok: true, id, status: "dismissed" });
  } catch (err) {
    console.error("[admin/bmi-sync] dismiss failed:", err);
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "failed" },
      { status: 500 },
    );
  }
}
