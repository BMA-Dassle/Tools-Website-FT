import { NextRequest, NextResponse } from "next/server";
import { verifyCron } from "@/lib/cron-auth";
import { logCronRun } from "@/lib/sms-log";
import {
  etHour,
  overnightClearEnabled,
  overnightWindowOpen,
  runEticketOvernightClear,
} from "~/features/eticket/overnight-clear";

/**
 * E-ticket overnight queue clear — thin shell over
 * src/features/eticket/overnight-clear.ts.
 *
 * Schedule: `20 7,8 * * *` in vercel.json — both UTC hours fire
 * year-round so the window is covered whichever side of DST (3:20/4:20am
 * EDT, 2:20/3:20am EST — usually BOTH land inside the 2–5am gate; the
 * purge is idempotent so the second firing no-ops). The in-code gate
 * below is so a manual curl outside the window can never wipe the
 * daytime queues. Offset :20 so it never stacks on wallet-overnight-clear
 * (:00). Same belt-and-braces pattern as that cron.
 *
 * ?dryRun=1 — report what would clear without touching either queue
 * (still honours the window via wouldRun so it reports truthfully).
 */
export async function GET(req: NextRequest) {
  const denied = verifyCron(req);
  if (denied) return denied;

  const dryRun = new URL(req.url).searchParams.get("dryRun") === "1";
  const started = Date.now();
  const hour = etHour();
  const wouldRun = overnightWindowOpen();

  if (!overnightClearEnabled()) {
    return NextResponse.json(
      { ok: true, skipped: "ETICKET_OVERNIGHT_CLEAR=false" },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  if (dryRun) {
    const summary = await runEticketOvernightClear({ dryRun: true });
    return NextResponse.json(
      { ok: true, dryRun: true, etHour: hour, wouldRun, ...summary },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  if (!wouldRun) {
    return NextResponse.json(
      { ok: true, skipped: "outside 2-5am ET window", etHour: hour },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  try {
    const summary = await runEticketOvernightClear({ dryRun: false });
    await logCronRun({
      ts: new Date().toISOString(),
      cron: "eticket-overnight-clear",
      dryRun: false,
      elapsedMs: Date.now() - started,
      invoker: req.headers.get("x-vercel-cron")
        ? "vercel-cron"
        : req.headers.get("user-agent") || "unknown",
      candidates: summary.retriesCleared + summary.quotaCleared,
      sent: 0,
      skipped: summary.retriesCleared + summary.quotaCleared,
      errors: 0,
    });
    return NextResponse.json(
      { ok: true, elapsedMs: Date.now() - started, ...summary },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    console.error("[eticket-overnight-clear] error:", err);
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "cron error" },
      { status: 500 },
    );
  }
}
