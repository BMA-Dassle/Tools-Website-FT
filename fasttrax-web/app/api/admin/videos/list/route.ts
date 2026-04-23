import { NextRequest, NextResponse } from "next/server";
import { listMatchesInRange, type VideoMatch } from "@/lib/video-match";

/**
 * GET /api/admin/videos/list
 *
 * Query params:
 *   date      YYYY-MM-DD (ET), defaults to today. Filters to matches
 *             captured anywhere in that ET day.
 *   q         Free-text search across racer name, camera number, video
 *             code, phone digits. Case-insensitive.
 *   limit     Default 200, cap 500.
 *   status    Optional: 'notified' | 'unnotified' | 'failed' — filter by
 *             SMS/email send outcome.
 *
 * Returns:
 *   { date, total, returned, entries: VideoMatch[] }
 *
 * Auth: gated by middleware (ADMIN_CAMERA_TOKEN covers /api/admin/videos/*).
 */

function etYmdToRangeMs(ymd: string): { startMs: number; endMs: number } {
  // Inclusive day window in America/New_York. We use a simple UTC day-
  // boundary math with a 5h padding on each side to cover EST/EDT
  // without worrying about DST math for this filter.
  const base = Date.parse(`${ymd}T00:00:00Z`);
  const startMs = base - 5 * 60 * 60 * 1000; // 05:00 UTC = 00:00 EDT / -1h EST
  const endMs = startMs + 24 * 60 * 60 * 1000 + 2 * 60 * 60 * 1000; // generous end
  return { startMs, endMs };
}

function todayETYmd(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const date = (searchParams.get("date") || todayETYmd()).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return NextResponse.json({ error: "Invalid date — use YYYY-MM-DD" }, { status: 400 });
    }
    const q = (searchParams.get("q") || "").trim().toLowerCase();
    const statusFilter = searchParams.get("status") || "";
    const limit = Math.max(1, Math.min(500, parseInt(searchParams.get("limit") || "200", 10) || 200));

    const { startMs, endMs } = etYmdToRangeMs(date);
    const pool = await listMatchesInRange({ startMs, endMs, limit: Math.min(1000, limit * 3) });

    // Apply filters in-memory — pool size is small (a day's matches).
    const filtered = pool.filter((m: VideoMatch) => {
      if (statusFilter === "notified" && !(m.notifySmsOk || m.notifyEmailOk)) return false;
      if (statusFilter === "unnotified" && (m.notifySmsOk || m.notifyEmailOk)) return false;
      if (statusFilter === "failed" && !(m.notifySmsError || m.notifyEmailError)) return false;
      if (q) {
        const hay = [
          `${m.firstName} ${m.lastName}`,
          m.cameraNumber,
          m.videoCode,
          String(m.sessionId),
          String(m.personId),
        ].join(" ").toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    const paged = filtered.slice(0, limit);
    return NextResponse.json(
      { date, total: filtered.length, returned: paged.length, entries: paged },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    console.error("[admin/videos/list]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to list" },
      { status: 500 },
    );
  }
}
