import { NextRequest, NextResponse } from "next/server";
import { verifyCron } from "@/lib/cron-auth";
import { runRaceStateWatch } from "~/features/signage/briefing/race-state-watch.server";

/**
 * GET /api/cron/race-state-watch — every minute (vercel.json).
 *
 * Samples each track's run state off the SMS-Timing socket and bookmarks the
 * track's cameras when a race pauses or resumes. Start and end are NOT here —
 * they arrive on the venue broadcast webhook with the venue's own stamps and are
 * marked from race-finish.server.ts, which is strictly better than sampling.
 *
 * Why this one has to be polled at all, and what the minute costs, is in
 * ~/features/signage/briefing/race-state-watch.server.ts.
 *
 * ?dryRun=1 — sample and report the transition, mark nothing. The memory is
 * still advanced, so a dry run consumes the transition it observed; use it to
 * see what the watcher sees, not as a rehearsal before an important race.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const denied = verifyCron(req);
  if (denied) return denied;
  try {
    const dryRun = req.nextUrl.searchParams.get("dryRun") === "1";
    const result = await runRaceStateWatch({ dryRun });
    // Only transitions are worth a log line — a minute of "still running" on
    // two tracks, all evening, would bury everything else.
    if (result.tracks.some((t) => t.transition)) {
      console.log("[cron/race-state-watch]", JSON.stringify(result));
    }
    return NextResponse.json(result);
  } catch (err) {
    console.error("[cron/race-state-watch]", err);
    return NextResponse.json({ error: "race state watch failed" }, { status: 500 });
  }
}
