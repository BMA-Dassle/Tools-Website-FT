import { NextRequest, NextResponse } from "next/server";
import redis from "@/lib/redis";
import {
  listMatchesInRange,
  listUnmatchedInRange,
  type VideoMatch,
  type UnmatchedVideo,
} from "@/lib/video-match";
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
  // Inclusive day window in America/New_York (ET).
  // Prior version had this inverted — it produced Apr-22 15:00 ET →
  // Apr-23 17:00 ET instead of the actual ET day, cutting off everything
  // after 5 PM. Staff noticed 'no videos since 4:53 PM'.
  //
  // Correct calc: if ymd is '2026-04-23', we want the window Apr-23
  // 00:00 ET → Apr-24 00:00 ET. In UTC that's Apr-23 04:00Z → Apr-24
  // 04:00Z during EDT (Apr-Oct). DST-aware offset per calendar month:
  // UTC-4 for EDT months, UTC-5 for EST — close enough for a daily
  // filter, which doesn't care about the 2-hour DST transition edge.
  const month = parseInt(ymd.slice(5, 7), 10);
  const isEDT = month >= 4 && month <= 10;
  const offsetHours = isEDT ? 4 : 5;
  const baseUtc = Date.parse(`${ymd}T00:00:00Z`);
  const startMs = baseUtc + offsetHours * 60 * 60 * 1000;
  const endMs = startMs + 24 * 60 * 60 * 1000;
  return { startMs, endMs };
}

function todayETYmd(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

/**
 * Row shape returned to the client. matched:true rows are full
 * VideoMatch records; matched:false rows are raw vt3 fields with no
 * racer/session info yet.
 */
type ListEntry =
  | (VideoMatch & { matched: true })
  | {
      matched: false;
      videoId: number;
      videoCode: string;
      systemNumber: string; // base / video.system.name
      cameraNumber?: number; // vt3 hardware camera (video.camera)
      customerUrl: string;
      thumbnailUrl?: string;
      capturedAt: string;
      duration?: number;
      matchedAt: string; // reuse so the UI sort + display logic stays uniform (= capturedAt for unmatched)
      firstName: string; // "(unknown)" placeholder so render code can stay dumb
      lastName: string;
      sessionId: "";
      personId: "";
      // VT3 impression / purchase overlay — same shape the cron writes onto
      // matched rows, so the UI's `👁 viewed` / `💰 purchased` chips work
      // uniformly regardless of match state.
      viewed?: boolean;
      firstViewedAt?: string;
      lastViewedAt?: string;
      purchased?: boolean;
      purchaseType?: string;
      unlockedAt?: string;
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
    const limit = Math.max(
      1,
      Math.min(500, parseInt(searchParams.get("limit") || "200", 10) || 200),
    );

    const { startMs, endMs } = etYmdToRangeMs(date);

    // 1. Matched videos — from our match log.
    const matches: ListEntry[] =
      show === "unmatched"
        ? []
        : (await listMatchesInRange({ startMs, endMs, limit: Math.min(1000, limit * 3) })).map(
            (m) => ({ ...m, matched: true as const }),
          );

    // 2. Unmatched — read from the Redis-backed unmatched registry.
    //    The webhook writes a record for every capture event whose
    //    kart had no camera-assign at capture time; saveVideoMatch
    //    removes the record when a video later becomes matched. So
    //    this view is mutually exclusive with the matched view above.
    //
    //    Replaces the prior `listRecentVideos({ limit: 200 })` polling
    //    path which capped the day at the 200 most recent VT3 videos —
    //    busy days (> 200 captures) lost visibility into older
    //    unmatched rows. The Redis log holds 7d × 5000 entries, way
    //    above our peak. VT3 fallback below covers the transitional
    //    window during which old captures predate this code.
    let unmatched: ListEntry[] = [];
    if (show !== "matched") {
      let unmatchedRecords: UnmatchedVideo[] = [];
      try {
        unmatchedRecords = await listUnmatchedInRange({
          startMs,
          endMs,
          limit: Math.min(2000, Math.max(limit * 3, 500)),
        });
      } catch (err) {
        console.error("[admin/videos/list] unmatched registry read failed:", err);
      }

      // Defensive: a Redis hiccup would leave the bucket empty. Drop
      // back to the legacy VT3 polling path so admin keeps working.
      // Same 200-cap caveat as before, but only on the failure mode.
      if (unmatchedRecords.length === 0 && show === "unmatched") {
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
            unmatchedRecords = candidates
              .filter((_, i) => !sentinels[i])
              .map((v) => ({
                videoId: v.id,
                videoCode: v.code,
                systemNumber: v.system?.name || "",
                cameraNumber: v.camera,
                customerUrl: `https://vt3.io/?code=${v.code}`,
                thumbnailUrl: v.thumbnailUrl,
                capturedAt: v.created_at,
                duration: v.duration,
                matchedAt: v.created_at,
                videoStatus: v.status,
                sampleUploadTime: v.sampleUploadTime ?? null,
                lastWebhookEventAt: v.created_at,
                viewed:
                  !!v.hasVideoPageImpression ||
                  !!v.hasMediaCentreImpression ||
                  !!v.firstImpressionAt ||
                  undefined,
                firstViewedAt: v.firstImpressionAt || undefined,
                lastViewedAt: v.lastImpressionAt || undefined,
                purchased: v.purchaseType === "PAID" || undefined,
                purchaseType: v.purchaseType || undefined,
                unlockedAt: v.unlockTime || undefined,
              }));
          }
        } catch (err) {
          console.error("[admin/videos/list] vt3 fallback failed:", err);
        }
      }

      unmatched = unmatchedRecords.map((u) => ({
        matched: false as const,
        videoId: u.videoId,
        videoCode: u.videoCode,
        systemNumber: u.systemNumber,
        cameraNumber: u.cameraNumber,
        customerUrl: u.customerUrl,
        thumbnailUrl: u.thumbnailUrl,
        capturedAt: u.capturedAt,
        duration: u.duration,
        matchedAt: u.matchedAt,
        firstName: "",
        lastName: "",
        sessionId: "" as const,
        personId: "" as const,
        viewed: u.viewed,
        firstViewedAt: u.firstViewedAt,
        lastViewedAt: u.lastViewedAt,
        purchased: u.purchased,
        purchaseType: u.purchaseType,
        unlockedAt: u.unlockedAt,
      }));
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
          ? [
              `${e.firstName} ${e.lastName}`,
              e.systemNumber,
              String(e.cameraNumber ?? ""),
              e.videoCode,
              String(e.sessionId),
              String(e.personId),
            ]
              .join(" ")
              .toLowerCase()
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
