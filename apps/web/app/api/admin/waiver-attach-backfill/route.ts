import { NextRequest, NextResponse } from "next/server";
import {
  listAttachBackfillCandidates,
  type KioskWaiverJoinRow,
} from "~/features/kiosk/data/kiosk-waiver-joins-db";
import { reattachJoinRows } from "~/features/kiosk/waiver/attach-backfill";
import { isAdminCredential } from "@/lib/admin-request-auth";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * GET /api/admin/waiver-attach-backfill?token=…&dryRun=1&limit=25&attachedBefore=…
 *
 * One-time remediation for the poisoned kiosk_waiver_joins rows: the pre-fix
 * attach (before 2026-07-30, commits 3fc3fdf1/717b117b) sent BMI the PROJECT id
 * where the endpoint wants a BILL id, and recorded the resulting
 * 200 {"success":false} as 'attached' — so those rows claim an attach that BMI
 * never received, and both the join route's alreadyAttached shortcut and
 * check-in's re-attach guard trust them forever. This route re-runs the attach
 * (with the corrected projectId→billId conversion) for:
 *   - every 'failed' row, and
 *   - every 'attached' row last touched before `attachedBefore`
 *     (default 2026-07-30T00:00:00Z — pass the actual fix DEPLOY time for a
 *     tighter sweep; a too-early cutoff misses poisoned rows, which a re-run
 *     with a later cutoff picks up, while a too-late one re-attaches genuinely
 *     attached people, whose BMI-side behavior is unverified).
 *
 * dryRun defaults ON — it reports exactly which rows would be re-attached and
 * mutates nothing. Run dark first, read the list, then re-run with dryRun=0.
 * Manual/admin-triggered on purpose: this touches BMI Office per row, and the
 * owner should watch the first live run (the A3 attach probe history).
 *
 * The reconcile-before-re-POST core (live roster is authority, unreadable ≠
 * empty, per-project memoization) moved to
 * ~/features/kiosk/waiver/attach-backfill so the kiosk-bmi-sync-sweep cron
 * shares the exact same safety rules. RECENT failures (last 48h) are the cron's
 * job now; this route remains the manual tool for the historical backlog and
 * for stale-'attached' archaeology, which the cron never touches.
 */

const DEFAULT_ATTACHED_BEFORE = "2026-07-30T00:00:00Z";
const MAX_LIMIT = 100;

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  if (!(await isAdminCredential(sp.get("token")))) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const dryRun = sp.get("dryRun") !== "0"; // mutating is the explicit opt-in
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number(sp.get("limit") ?? "25") || 25));
  const attachedBefore = sp.get("attachedBefore") ?? DEFAULT_ATTACHED_BEFORE;
  if (Number.isNaN(Date.parse(attachedBefore))) {
    return NextResponse.json({ ok: false, error: "attachedBefore must be ISO" }, { status: 400 });
  }

  let candidates: KioskWaiverJoinRow[];
  try {
    candidates = await listAttachBackfillCandidates({ attachedBefore, limit });
  } catch (err) {
    console.error("[waiver-attach-backfill] candidate query failed:", err);
    return NextResponse.json({ ok: false, error: "query failed" }, { status: 500 });
  }

  const { outcomes, counts } = await reattachJoinRows(candidates, { dryRun });

  return NextResponse.json({
    ok: true,
    dryRun,
    attachedBefore,
    candidates: candidates.length,
    counts,
    outcomes,
  });
}
