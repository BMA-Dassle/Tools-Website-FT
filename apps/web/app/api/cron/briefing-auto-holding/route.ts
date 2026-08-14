import { NextRequest, NextResponse } from "next/server";
import { verifyCron } from "@/lib/cron-auth";
import { runAutoHolding } from "~/features/signage/briefing/auto-holding.server";

/**
 * GET /api/cron/briefing-auto-holding — every minute (vercel.json).
 *
 * Asks each briefing room's camera whether the group has left, and moves them to
 * holding if they have. Everything that matters — the eligibility gate, the
 * evidence, the reason this is not the auto-advance timer that was removed — is
 * in ~/features/signage/briefing/auto-holding.ts.
 *
 * EVERY MINUTE IS THE RIGHT CADENCE, not a compromise. The backtest put the
 * median detection 1:29 after the film ends, so a minute of cron granularity
 * lands the move around two and a half minutes out — against a button that was
 * pressed 7 times in ~60 briefings. Polling faster would spend Nx calls to
 * sharpen a number nobody is watching.
 *
 * The sweep costs nothing when nothing is happening: rooms that are idle or mid-
 * film are decided from Redis alone and the relay is never called.
 *
 * ?dryRun=1 — decide and report, but claim nothing and move nobody. This is the
 * switch to use on the first race night: it answers "would it have fired, and
 * when" without touching the pit lane.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const denied = verifyCron(req);
  if (denied) return denied;
  try {
    const dryRun = req.nextUrl.searchParams.get("dryRun") === "1";
    const result = await runAutoHolding({ dryRun });
    // Logged as well as returned: a cron response is only ever seen by whoever
    // goes looking, and the interesting case (it moved somebody) should be in
    // the logs beside the sendToHolding it caused.
    if (result.moved > 0) console.log("[cron/briefing-auto-holding]", JSON.stringify(result));
    return NextResponse.json(result);
  } catch (err) {
    console.error("[cron/briefing-auto-holding]", err);
    return NextResponse.json({ error: "auto-holding sweep failed" }, { status: 500 });
  }
}
