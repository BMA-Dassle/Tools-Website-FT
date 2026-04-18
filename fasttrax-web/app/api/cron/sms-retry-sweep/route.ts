import { NextRequest, NextResponse } from "next/server";
import { drainRetries, pendingCount } from "@/lib/sms-retry";
import { logCronRun } from "@/lib/sms-log";

/**
 * SMS retry sweep — runs every minute to drain due retries across BOTH crons.
 *
 * Without this, a retry queued from a pre-race failure could sit up to 5
 * minutes before the pre-race cron next fires. The sweep catches retries
 * the instant their retry-after has passed.
 *
 * Cron schedule: `* * * * *` (every minute) in vercel.json.
 */
export async function GET(req: NextRequest) {
  const started = Date.now();
  const dryRun = new URL(req.url).searchParams.get("dryRun") === "1";

  try {
    const [preRace, checkin, pending] = await Promise.all([
      dryRun ? Promise.resolve({ attempted: 0, ok: 0, requeued: 0, dead: 0 }) : drainRetries("pre-race-cron"),
      dryRun ? Promise.resolve({ attempted: 0, ok: 0, requeued: 0, dead: 0 }) : drainRetries("checkin-cron"),
      pendingCount(),
    ]);

    const sent = preRace.ok + checkin.ok;
    const errors = preRace.requeued + checkin.requeued + preRace.dead + checkin.dead;

    await logCronRun({
      ts: new Date().toISOString(),
      cron: "checkin", // nearest existing bucket — extend CronRunEntry type later if we need a dedicated "sweep" category
      dryRun,
      elapsedMs: Date.now() - started,
      invoker: req.headers.get("x-vercel-cron") ? "vercel-cron" : (req.headers.get("user-agent") || "unknown"),
      candidates: preRace.attempted + checkin.attempted,
      sent,
      skipped: 0,
      errors,
    });

    return NextResponse.json({
      ok: true,
      dryRun,
      elapsedMs: Date.now() - started,
      preRace,
      checkin,
      pendingAfter: pending,
    });
  } catch (err) {
    console.error("[sms-retry-sweep] error:", err);
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "sweep error" },
      { status: 500 },
    );
  }
}
