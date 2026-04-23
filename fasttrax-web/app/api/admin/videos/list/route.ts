import { NextRequest, NextResponse } from "next/server";
import redis from "@/lib/redis";
import { listMatchesInRange, type VideoMatch } from "@/lib/video-match";
import { listRecentVideos } from "@/lib/vt3";

/**
 * GET /api/admin/videos/list
 *
 * Query params:
 *   date              YYYY-MM-DD (ET), defaults to today. Filters to
 *                     videos captured anywhere in that ET day.
 *   show              'all' (default) | 'matched' | 'unmatched'
 *   q                 Free-text search across racer name, camera number,
 *                     video code, phone digits. Case-insensitive.
 *   limit             Default 200, cap 500.
 *   status            Optional: 'notified' | 'unnotified' | 'failed' —
 *                     filters matched rows by notify outcome. (Ignored
 *                     for unmatched since they have no send state yet.)
 *
 * Returns:
 *   {
 *     date, total, returned,
 *     entries: Array<VideoMatch & { matched: boolean }>
 *   }
 *
 * Entries with matched:false lack racer/session info — they're raw
 * vt3.io records staff can send to manually (supply phone/email at
 * send time). When a staff-send succeeds, the send endpoint creates
 * a real match record, so the row transitions to matched:true on the
 * next refresh.
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

/**
 * Row shape returned to the client. matched:true rows are full
 * VideoMatch records; matched:false rows are raw vt3 fields with no
 * racer/session info yet.
 */
type ListEntry = (VideoMatch & { matched: true }) | {
  matched: false;
  videoId: number;
  videoCode: string;
  systemNumber: string;      // base / video.system.name
  cameraNumber?: number;     // vt3 hardware camera (video.camera)
  customerUrl: string;
  thumbnailUrl?: string;
  capturedAt: string;
  duration?: number;
  matchedAt: string; // reuse so the UI sort + display logic stays uniform (= capturedAt for unmatched)
  firstName: string; // "(unknown)" placeholder so render code can stay dumb
  lastName: string;
  sessionId: "";
  personId: "";
};

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const date = (searchParams.get("date") || todayETYmd()).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return NextResponse.json({ error: "Invalid date — use YYYY-MM-DD" }, { status: 400 });
    }
    const q = (searchParams.get("q") || "").trim().toLowerCase();
    const statusFilter = searchParams.get("status") || "";
    const show = (searchParams.get("show") || "all").toLowerCase();
    const limit = Math.max(1, Math.min(500, parseInt(searchParams.get("limit") || "200", 10) || 200));

    const { startMs, endMs } = etYmdToRangeMs(date);

    // 1. Matched videos — from our match log.
    const matches: ListEntry[] =
      show === "unmatched"
        ? []
        : (await listMatchesInRange({ startMs, endMs, limit: Math.min(1000, limit * 3) }))
            .map((m) => ({ ...m, matched: true as const }));

    // 2. Unmatched — fetch recent vt3 videos for the FastTrax site,
    //    filter to the date window, skip any that are already matched
    //    (sentinel check) or about to be matched (camera-watch present,
    //    meaning a camera-assign exists for them and the cron will
    //    pick them up next tick).
    let unmatched: ListEntry[] = [];
    if (show !== "matched") {
      try {
        const siteId = parseInt(process.env.VT3_SITE_ID || "992", 10);
        const vids = await listRecentVideos({ siteId, limit: 200 });
        const candidates = vids.filter((v) => {
          const t = new Date(v.created_at).getTime();
          return t >= startMs && t <= endMs;
        });
        if (candidates.length > 0) {
          const sentinelKeys = candidates.map((v) => `video-match:by-code:${v.code}`);
          const sentinels = sentinelKeys.length ? await redis.mget(...sentinelKeys) : [];
          unmatched = candidates
            .filter((_, i) => !sentinels[i])
            .map((v) => ({
              matched: false as const,
              videoId: v.id,
              videoCode: v.code,
              systemNumber: v.system?.name || "",
              cameraNumber: v.camera,
              customerUrl: `https://vt3.io/?code=${v.code}`,
              thumbnailUrl: v.thumbnailUrl,
              capturedAt: v.created_at,
              duration: v.duration,
              matchedAt: v.created_at, // treat capture time as the sortable timestamp
              firstName: "",
              lastName: "",
              sessionId: "",
              personId: "",
            }));
        }
      } catch (err) {
        // VT3 API failure shouldn't kill the whole list — matched rows
        // are still useful. Log and continue.
        console.error("[admin/videos/list] vt3 fetch failed:", err);
      }
    }

    // 3. Merge + sort newest-first by matchedAt (which for unmatched =
    //    capturedAt, and for matched = when the cron linked it).
    let merged: ListEntry[] = [...matches, ...unmatched];
    merged.sort((a, b) => new Date(b.matchedAt).getTime() - new Date(a.matchedAt).getTime());

    // 4. Apply filters.
    merged = merged.filter((e) => {
      if (e.matched) {
        if (statusFilter === "notified" && !(e.notifySmsOk || e.notifyEmailOk)) return false;
        if (statusFilter === "unnotified" && (e.notifySmsOk || e.notifyEmailOk)) return false;
        if (statusFilter === "failed" && !(e.notifySmsError || e.notifyEmailError)) return false;
      }
      if (q) {
        const hay = e.matched
          ? [`${e.firstName} ${e.lastName}`, e.systemNumber, String(e.cameraNumber ?? ""), e.videoCode, String(e.sessionId), String(e.personId)]
              .join(" ").toLowerCase()
          : [e.systemNumber, String(e.cameraNumber ?? ""), e.videoCode].join(" ").toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    const paged = merged.slice(0, limit);
    return NextResponse.json(
      { date, total: merged.length, returned: paged.length, entries: paged },
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
