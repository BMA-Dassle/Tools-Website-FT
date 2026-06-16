import { NextRequest, NextResponse } from "next/server";
import { closePastReservationStatuses } from "@/lib/bowling-db";
import { completeCheckedInOrders } from "@/lib/bowling-order-complete";
import { verifyCron } from "@/lib/cron-auth";

/**
 * GET /api/cron/reservation-status-close
 *
 * End-of-session close for past bowling reservations. Two steps:
 *
 * 1. STATUS close (visibility, not money). Flips past-event reservations still
 *    in a non-terminal status (confirmed/arrived) to a terminal one — completed
 *    (showed/settled) or no_show (never showed, nothing to collect) — so the
 *    admin board's "Active Only" view shows ZERO leftovers on previous days.
 *
 * 2. ORDER complete. For checked-in (showed-up), paid, session-over orders whose
 *    day-of Square order is still OPEN, complete the fulfillment + order so it
 *    imports into QuickBooks as a closed sale. Lane-open leaves these OPEN on
 *    purpose (KDS needs the fulfillment during the session); this finishes the
 *    lifecycle once the session is well over. See
 *    docs/postmortems/2026-06-16-bowling-day-of-orders-left-open.md.
 *
 * Combos are excluded (held / own settle flow); confirm_failed/confirm_pending
 * are left alone (real issues that should stay visible). Runs AFTER the
 * money-settlement crons (bowling-no-show-close, race-dayof-pay): a funded,
 * unsettled no-show is left for those to charge first.
 *
 * ?dryRun=1 — report counts, no writes. ?token= for manual/on-demand.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const manualToken = req.nextUrl.searchParams.get("token");
  const isManual =
    !!process.env.ADMIN_CAMERA_TOKEN && manualToken === process.env.ADMIN_CAMERA_TOKEN;
  if (!isManual) {
    const blocked = verifyCron(req);
    if (blocked) return blocked;
  }
  const dryRun = req.nextUrl.searchParams.get("dryRun") === "1";

  const res = await closePastReservationStatuses({ dryRun });
  const orders = await completeCheckedInOrders({ dryRun });
  console.log(
    `[reservation-status-close] dryRun=${dryRun} completed=${res.completed} no_show=${res.noShow} ` +
      `pendingSettle=${res.pendingSettle} | ordersCompleted=${orders.completed} already=${orders.already} ` +
      `skipped=${orders.skipped} failed=${orders.failed} closed=$${orders.completedCents / 100}`,
  );
  return NextResponse.json({ ok: true, dryRun, ...res, orders });
}
