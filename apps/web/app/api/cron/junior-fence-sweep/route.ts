import { NextRequest, NextResponse } from "next/server";
import { verifyCron } from "@/lib/cron-auth";
import { runJuniorFenceSweep } from "~/features/racing/junior-fence.server";
import { etHourMinute, shouldSweepNow } from "~/features/racing/junior-fence-cadence";

/**
 * GET /api/cron/junior-fence-sweep — every minute (vercel.json).
 *
 * Locks the "Adult Only" BMI product limit onto the still-EMPTY heats either
 * side of a booked junior race, so no channel can sell a back-to-back junior
 * session. Our own picker already blocks this on web and kiosk; the register
 * does not, and 30 days of live sessions carried 125 back-to-back junior pairs
 * anyway (~4.3/day). A BMI-side limit binds every channel at once.
 *
 * Same-day only — this is the live one. Future dates are a rolling sweep and
 * are NOT wired up yet: writes to a date BMI has not materialised are untested.
 *
 * Add-only. Nothing is known to clear a BMI product limit, so fences whose
 * junior booking has gone away are reported in `shouldClear` for ops to reset
 * by hand (owner 2026-08-16), never executed.
 *
 * Why this is safe to run every minute: the planner is idempotent — an
 * already-fenced slot reads as `keep`, not `add` — so a quiet minute makes two
 * reads and zero writes. Writes are capped at 20/run.
 *
 * ?dryRun=1 — plan and report, write nothing.
 * ?date=YYYY-MM-DD — sweep a specific center-local date instead of today.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const denied = verifyCron(req);
  if (denied) return denied;
  try {
    const dryRun = req.nextUrl.searchParams.get("dryRun") === "1";
    const date = req.nextUrl.searchParams.get("date") ?? undefined;

    /**
     * SKIP THE MINUTES NOBODY CAN BUY IN.
     *
     * This is scheduled every minute and each run costs Pandora three live
     * calls — ~4,320/day, the largest single thing we asked that vendor for.
     * Measured from the venue wire's booking events, 02:00-08:59 ET carried
     * EIGHT of 2,664 across two and a half days: the venue is shut, no heat is
     * inside the planner's 15-minute lead, and nothing can be sold out from
     * under a junior race. Through that window it drops to one run in ten.
     *
     * Never applies to a MANUAL call — an explicit ?date= or ?dryRun=1 is
     * somebody at a keyboard, and they should not have to wait for the clock.
     */
    const manual = dryRun || !!date;
    if (!manual && !shouldSweepNow(etHourMinute(Date.now()))) {
      return NextResponse.json({ ok: true, skipped: "quiet-hours" });
    }

    const result = await runJuniorFenceSweep({ dryRun, date });

    // Most minutes are "nothing to do" — logging those would bury the days this
    // actually fires. Log only when we wrote, raced, failed, or owe ops a reset.
    if (
      result.wrote.length ||
      result.raced.length ||
      result.shouldClear.length ||
      result.notes.length ||
      !result.ok
    ) {
      console.log("[cron/junior-fence-sweep]", JSON.stringify(result));
    }
    return NextResponse.json(result);
  } catch (err) {
    console.error("[cron/junior-fence-sweep]", err);
    return NextResponse.json({ error: "junior fence sweep failed" }, { status: 500 });
  }
}
