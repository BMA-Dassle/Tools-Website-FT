import { NextRequest, NextResponse } from "next/server";
import { readSmsLog, type SmsLogEntry } from "@/lib/sms-log";

/**
 * SMS log reader.
 *
 *   GET /api/sms-log
 *     ?date=2026-04-18        — YYYY-MM-DD in ET, defaults to today
 *     ?limit=200              — max entries (default 200, cap 2000)
 *     ?offset=0               — pagination (newest-first)
 *     ?phone=+12395551234     — filter: exact canonical phone match
 *     ?source=checkin-cron    — filter by source
 *     ?ok=false               — filter by success/failure
 *     ?sessionId=44592374     — filter: entry covers this session
 *     ?personId=780070        — filter: entry covers this person
 *
 * Returns { date, total, returned, entries: [...] } newest-first.
 * No auth — internal tool. Add key check if you expose publicly.
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
  const limit = Math.max(1, Math.min(2000, parseInt(searchParams.get("limit") || "200", 10) || 200));
  const offset = Math.max(0, parseInt(searchParams.get("offset") || "0", 10) || 0);

  const phone = searchParams.get("phone");
  const source = searchParams.get("source");
  const okParam = searchParams.get("ok");
  const sessionId = searchParams.get("sessionId");
  const personId = searchParams.get("personId");

  // Pull more than requested so filters don't starve the page size.
  const poolSize = Math.min(2000, Math.max(limit * 4, 500));
  const pool = await readSmsLog(date, { limit: poolSize, offset });

  const filtered: SmsLogEntry[] = pool.filter((e) => {
    if (phone && e.phone !== phone) return false;
    if (source && e.source !== source) return false;
    if (okParam === "true" && !e.ok) return false;
    if (okParam === "false" && e.ok) return false;
    if (sessionId && !(e.sessionIds || []).map(String).includes(sessionId)) return false;
    if (personId && !(e.personIds || []).map(String).includes(personId)) return false;
    return true;
  });

  const entries = filtered.slice(0, limit);

  return NextResponse.json(
    { date, total: filtered.length, returned: entries.length, entries },
    { headers: { "Cache-Control": "no-store" } },
  );
}
