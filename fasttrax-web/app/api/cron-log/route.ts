import { NextRequest, NextResponse } from "next/server";
import { readCronLog, type CronRunEntry } from "@/lib/sms-log";

/**
 * Cron-run log reader — answers "is the cron actually firing?"
 *
 *   GET /api/cron-log
 *     ?date=2026-04-18 (ET, defaults to today)
 *     ?cron=pre-race|checkin
 *     ?limit=200&offset=0
 *     ?invoker=vercel-cron  (filter to autonomous fires)
 *
 * Same auth pattern as /api/sms-log.
 */

const API_KEY = process.env.BOOKING_API_KEY || "CMXDJ9fct3--Js6u_c_mXUKGcv1GbbBBspVSuipdiT4";

function todayETYmd(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}

function requireAuth(req: NextRequest): NextResponse | null {
  const referer = req.headers.get("referer") || "";
  const origin = req.headers.get("origin") || "";
  const host = req.headers.get("host") || "";
  if (referer.includes(host) || origin.includes(host)) return null;
  const key = req.headers.get("x-api-key") || new URL(req.url).searchParams.get("apiKey");
  if (!key || key !== API_KEY) {
    return NextResponse.json({ error: "Unauthorized — provide x-api-key" }, { status: 401 });
  }
  return null;
}

export async function GET(req: NextRequest) {
  const authErr = requireAuth(req);
  if (authErr) return authErr;

  const { searchParams } = new URL(req.url);
  const date = (searchParams.get("date") || todayETYmd()).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return NextResponse.json({ error: "Invalid date — use YYYY-MM-DD" }, { status: 400 });
  }
  const limit = Math.max(1, Math.min(2000, parseInt(searchParams.get("limit") || "500", 10) || 500));
  const offset = Math.max(0, parseInt(searchParams.get("offset") || "0", 10) || 0);

  const cron = searchParams.get("cron");
  const invokerFilter = searchParams.get("invoker");

  const pool = await readCronLog(date, { limit: Math.min(2000, limit * 4), offset });
  const filtered: CronRunEntry[] = pool.filter((e) => {
    if (cron && e.cron !== cron) return false;
    if (invokerFilter && e.invoker !== invokerFilter) return false;
    return true;
  });
  const entries = filtered.slice(0, limit);

  // Summary: fires per cron + gap analysis
  const byCron = new Map<string, CronRunEntry[]>();
  for (const e of entries) {
    if (!byCron.has(e.cron)) byCron.set(e.cron, []);
    byCron.get(e.cron)!.push(e);
  }
  const summary: Record<string, { fires: number; lastFiredAt: string | null; totalSent: number; autonomous: number }> = {};
  for (const [k, list] of byCron) {
    // Vercel sends invoker="vercel-cron/1.0" (with version suffix), so match by prefix
    const autonomous = list.filter((e) => (e.invoker || "").startsWith("vercel-cron")).length;
    const sent = list.reduce((a, b) => a + (b.sent || 0), 0);
    summary[k] = {
      fires: list.length,
      lastFiredAt: list[0]?.ts || null,
      totalSent: sent,
      autonomous,
    };
  }

  return NextResponse.json(
    { date, total: filtered.length, returned: entries.length, summary, entries },
    { headers: { "Cache-Control": "no-store" } },
  );
}
