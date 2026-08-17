import { NextRequest, NextResponse } from "next/server";
import { verifyCron } from "@/lib/cron-auth";
import { buildReel } from "~/features/pov-reel/service";

/**
 * Daily highlight-reel build. Thin shell — auth, then delegate.
 *
 * `?dryRun=1` does everything except dispatch, write and delete, returning
 * exactly the plan it would have executed. Run that before the first live build:
 * the clipper has never cut a real video, and the plan is where you see whether
 * the week actually produced ten eligible racers.
 */
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const denied = verifyCron(req);
  if (denied) return denied;

  const dryRun = req.nextUrl.searchParams.get("dryRun") === "1";
  const report = await buildReel({ dryRun });
  // A clipper that is down or misconfigured is a real failure and must not read
  // as a clean run in the cron log — the rows it left behind get re-dispatched
  // tomorrow, but somebody should see it today.
  const status = report.error || report.clipperStatus ? 502 : 200;
  return NextResponse.json(report, { status });
}
