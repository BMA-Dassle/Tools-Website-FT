import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { recordCrash, toCrashReport } from "~/features/signage/crash-log.server";

/**
 * Where a screen posts the exception that just took a scene — or the whole
 * panel — down.
 *
 * PUBLIC, no token, the same posture as /api/tv/feed beside it: the reporter is
 * a TV that has already crashed, and a panel cannot be asked to authenticate on
 * the way down. Nothing here is readable from the outside — this endpoint only
 * ever writes, and always answers 204 whatever happened, so it can be neither
 * probed nor made to fail a screen that is already having a bad night.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const report = toCrashReport(await req.json(), new Date().toISOString());
    // Logged as well as stored: Vercel's runtime log is where somebody looks
    // first, and it survives Redis being unreachable.
    if (report) {
      console.error(
        `[tv-crash] ${report.origin} ${report.screen ?? "?"} build=${report.build ?? "?"} ` +
          `scene=${report.scene ?? "-"} :: ${report.message}`,
      );
      await recordCrash(report);
    }
  } catch {
    /* A malformed report is not worth a status a screen would have to handle. */
  }
  return new NextResponse(null, { status: 204 });
}
