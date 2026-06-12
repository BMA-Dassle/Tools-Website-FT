import { NextRequest, NextResponse } from "next/server";
import { drainRetries } from "@/lib/sms-retry";
import { logCronRun } from "@/lib/sms-log";
import { verifyCron } from "@/lib/cron-auth";
import { runArenaCheckinAlerts } from "~/features/arena-tickets/checkin-alerts";

/**
 * HP Arena "now checking in" alert cron — thin shell over
 * src/features/arena-tickets/checkin-alerts.ts. Every minute (like the
 * racing checkin-alerts cron): polls Pandora's sessions/current for
 * called arena sessions, flags race:called:{sid} for the ticket-page
 * banner, and texts/emails participants the urgent check-in alert.
 *
 * ?dryRun=1 — log who would receive but don't send (and don't flag)
 */
export async function GET(req: NextRequest) {
  const denied = verifyCron(req);
  if (denied) return denied;

  const dryRun = new URL(req.url).searchParams.get("dryRun") === "1";
  const started = Date.now();

  const retryStats = !dryRun
    ? await drainRetries("arena-checkin-cron")
    : { attempted: 0, ok: 0, requeued: 0, dead: 0, quotaQueued: 0 };

  try {
    const summary = await runArenaCheckinAlerts({ dryRun });

    await logCronRun({
      ts: new Date().toISOString(),
      cron: "arena-checkin",
      dryRun,
      elapsedMs: Date.now() - started,
      invoker: req.headers.get("x-vercel-cron")
        ? "vercel-cron"
        : req.headers.get("user-agent") || "unknown",
      candidates: summary.candidates,
      sent: summary.sent,
      skipped: summary.skipped,
      errors: summary.errors,
      groupedSmsSends: summary.groupedSmsSends,
      singleSmsSends: summary.singleSmsSends,
      emailSends: summary.emailSends,
    });

    return NextResponse.json({
      ok: true,
      dryRun,
      elapsedMs: Date.now() - started,
      ...summary,
      retries: retryStats,
    });
  } catch (err) {
    console.error("[arena-checkin] error:", err);
    await logCronRun({
      ts: new Date().toISOString(),
      cron: "arena-checkin",
      dryRun,
      elapsedMs: Date.now() - started,
      invoker: req.headers.get("x-vercel-cron")
        ? "vercel-cron"
        : req.headers.get("user-agent") || "unknown",
      candidates: 0,
      sent: 0,
      skipped: 0,
      errors: 1,
      fatalError: err instanceof Error ? err.message : "cron error",
    });
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "cron error" },
      { status: 500 },
    );
  }
}
