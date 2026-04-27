import { NextRequest, NextResponse } from "next/server";
import { downloadKbfCsv, parseKbfCsv, syncKbfFromCsv } from "@/lib/kbf-sync";

/**
 * Hourly Kids Bowl Free center-report sync.
 *
 *   GET /api/cron/kbf-sync           — full sync (download + upsert)
 *   GET /api/cron/kbf-sync?dryRun=1  — download + parse + report counts only
 *   GET /api/cron/kbf-sync?probe=1   — short-circuit; no network or DB call
 *
 * Pulls the master CSV from KidsBowlFree.com via the same form-POST
 * flow a center user does in the browser, parses the wide-format
 * kid + family slots into a normalized schema, and upserts into
 * Neon (`kbf_passes` + `kbf_pass_members`).
 *
 * Schedule: `0 * * * *` (top of every hour) in vercel.json.
 *
 * Failure modes worth alerting on:
 *  - "KBF_PASSWORD env var not set" — env missing on this deploy
 *  - "auth likely lapsed" content-type — center password rotated
 *  - Hard HTTP 5xx from KBF — Sucuri Cloudproxy issue, retries next hour
 */

export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const started = Date.now();
  const url = new URL(req.url);

  // Cheap probe — for deploy-status polling without firing the real flow.
  if (url.searchParams.get("probe") === "1") {
    return NextResponse.json({ ok: true, probe: true });
  }

  const dryRun = url.searchParams.get("dryRun") === "1";
  const invoker = req.headers.get("x-vercel-cron") ? "vercel-cron" : (req.headers.get("user-agent") || "manual");

  try {
    const csv = await downloadKbfCsv();
    const csvSize = csv.length;

    if (dryRun) {
      const parsed = parseKbfCsv(csv);
      const memberCount = parsed.reduce((acc, p) => acc + p.members.length, 0);
      const byCenter: Record<string, number> = {};
      for (const p of parsed) {
        byCenter[p.pass.centerName] = (byCenter[p.pass.centerName] || 0) + 1;
      }
      return NextResponse.json({
        ok: true,
        dryRun: true,
        invoker,
        csvSize,
        rowsParsed: parsed.length,
        membersParsed: memberCount,
        byCenter,
        durationMs: Date.now() - started,
      });
    }

    const result = await syncKbfFromCsv(csv);
    return NextResponse.json({
      ok: true,
      invoker,
      csvSize,
      ...result,
      durationMs: Date.now() - started,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "kbf-sync failed";
    console.error("[kbf-sync] failed:", msg);
    return NextResponse.json(
      { ok: false, error: msg, invoker, durationMs: Date.now() - started },
      { status: 500 },
    );
  }
}
