import { NextRequest, NextResponse } from "next/server";
import { sendWelcomeEmailBatch } from "@/lib/kbf-welcome-email";

/**
 * Backfill cron — sends welcome emails to existing KBF registrations
 * that haven't received one yet.
 *
 * Runs every minute, sending up to 20 emails per invocation ≈ 20/min
 * pace. This is intentionally separate from the sync cron so:
 *
 *   1. New sign-ups get their email immediately via the sync cron
 *      (which uses `recentMinutes` to target fresh registrations).
 *   2. The 2,300+ backlog drains gradually without overloading
 *      SendGrid or triggering spam filters.
 *
 * Once the backlog is cleared, this cron becomes a no-op (0 unsent
 * passes → 0 emails → fast return). Can be removed from vercel.json
 * after the backfill is complete.
 *
 * Schedule: `* * * * *` (every minute) in vercel.json.
 */

export const maxDuration = 60;

export async function GET(req: NextRequest) {
  if (process.env.VERCEL_ENV && process.env.VERCEL_ENV !== "production") {
    return NextResponse.json({ ok: true, skipped: "not production" });
  }

  const started = Date.now();
  const invoker = req.headers.get("x-vercel-cron")
    ? "vercel-cron"
    : req.headers.get("user-agent") || "manual";

  try {
    // No recentMinutes → grabs oldest unsent passes first (backfill mode)
    const result = await sendWelcomeEmailBatch(20);

    if (result.sent > 0 || result.failed > 0) {
      console.log(
        `[kbf-welcome-emails] Backfill: ${result.sent} sent, ${result.failed} failed, ${result.total} queued`,
      );
    }

    return NextResponse.json({
      ok: result.failed === 0,
      invoker,
      ...result,
      durationMs: Date.now() - started,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "welcome-email backfill failed";
    console.error("[kbf-welcome-emails] failed:", msg);
    return NextResponse.json(
      { ok: false, error: msg, invoker, durationMs: Date.now() - started },
      { status: 500 },
    );
  }
}
