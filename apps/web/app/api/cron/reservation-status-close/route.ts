import { NextRequest, NextResponse } from "next/server";
import { closePastReservationStatuses } from "@/lib/bowling-db";
import { verifyCron } from "@/lib/cron-auth";

/**
 * GET /api/cron/reservation-status-close
 *
 * End-of-night STATUS close (visibility, not money). Flips past-event
 * reservations still sitting in a non-terminal status (confirmed/arrived) to a
 * terminal one — completed (showed/settled) or no_show (never showed, nothing
 * to collect) — so the admin board's "Active Only" view shows ZERO leftovers on
 * previous days. Combos are excluded (held); confirm_failed/confirm_pending are
 * left alone (real issues that should stay visible).
 *
 * Runs AFTER the money-settlement crons (bowling-no-show-close, race-dayof-pay):
 * a funded, unsettled no-show is left for those to charge first, then a later
 * run flips it. Scheduled 08:30 UTC (~30 min after the 08:00 settle crons).
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
  console.log(
    `[reservation-status-close] dryRun=${dryRun} completed=${res.completed} no_show=${res.noShow} pendingSettle=${res.pendingSettle}`,
  );
  return NextResponse.json({ ok: true, dryRun, ...res });
}
