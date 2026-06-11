import { NextRequest, NextResponse } from "next/server";
import redis from "@/lib/redis";
import { drainRetries } from "@/lib/sms-retry";
import { logCronRun } from "@/lib/sms-log";
import { verifyCron } from "@/lib/cron-auth";
import { runArenaTicketCron } from "~/features/arena-tickets/service";

/**
 * HP Arena pre-session e-ticket cron — thin shell over
 * src/features/arena-tickets/service.ts (v2 convention: route parses /
 * authenticates / locks, the feature service does the work).
 *
 * Every 2 min once scheduled in vercel.json (PR-4 — deploy first, dry-run
 * via curl, then add the schedule). Looks at HP Arena sessions starting
 * in the next ~2 hours at HeadPinz FM and sends each participant a
 * HeadPinz-branded e-ticket. Separate route from pre-race-tickets on
 * purpose: independent dry-run/kill switch, and the racing cron's lock
 * would serialize both workloads behind Pandora's worst-case fetches.
 *
 * ?dryRun=1 — log who would receive but don't send
 */

const CRON_LOCK_KEY = "cron-lock:arena-pre";
const CRON_LOCK_TTL = 90;

export async function GET(req: NextRequest) {
  const denied = verifyCron(req);
  if (denied) return denied;

  const dryRun = new URL(req.url).searchParams.get("dryRun") === "1";
  const started = Date.now();

  if (!dryRun) {
    const acquired = await redis.set(CRON_LOCK_KEY, "1", "EX", CRON_LOCK_TTL, "NX");
    if (!acquired) {
      return NextResponse.json(
        { ok: true, locked: true, note: "previous run still in flight" },
        { headers: { "Cache-Control": "no-store" } },
      );
    }
  }

  // Drain due retries first — transient failures self-heal without
  // waiting for the main scan to re-identify the player as fresh.
  const retryStats = !dryRun
    ? await drainRetries("arena-pre-cron")
    : { attempted: 0, ok: 0, requeued: 0, dead: 0, quotaQueued: 0 };

  try {
    const summary = await runArenaTicketCron({ dryRun });

    await logCronRun({
      ts: new Date().toISOString(),
      cron: "arena-pre",
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
    console.error("[arena-pre] error:", err);
    await logCronRun({
      ts: new Date().toISOString(),
      cron: "arena-pre",
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
  } finally {
    if (!dryRun) {
      try {
        await redis.del(CRON_LOCK_KEY);
      } catch {
        /* best-effort */
      }
    }
  }
}
