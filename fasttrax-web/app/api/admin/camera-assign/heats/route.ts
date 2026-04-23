import { NextRequest, NextResponse } from "next/server";
import { readSmsLog } from "@/lib/sms-log";

/**
 * GET /api/admin/camera-assign/heats
 *
 * Query params:
 *   track=blue|red|mega   required — scoped to one resource
 *   before=N              default 4, max 10 — how many called heats to
 *                         return (including the most-recent = 'now')
 *   after=N               default 3, max 10 — how many upcoming scheduled
 *                         heats to return
 *
 * Returns:
 *   {
 *     called:   [...] // newest-first, from SMS log (checkin-cron)
 *     upcoming: [...] // soonest-first, from Pandora schedule
 *   }
 *
 * Single-trip replacement for /called + /upcoming — reduces the visible
 * two-wave render on the camera-assign page (prev pills arriving seconds
 * before the upcoming pills was jarring).
 *
 * Auth: middleware gates /api/admin/camera-assign/* on ADMIN_CAMERA_TOKEN.
 */

const BASE = process.env.NEXT_PUBLIC_SITE_URL || "https://fasttraxent.com";
const FASTTRAX_LOCATION_ID = "LAB52GY480CJF";
const TRACK_RESOURCES = ["Blue Track", "Red Track", "Mega Track"] as const;

interface PandoraSession {
  sessionId: string;
  name: string;
  scheduledStart: string;
  type: string;
  heatNumber: number;
}

interface HeatEntry {
  sessionId: string | number;
  name: string;
  scheduledStart: string;
  track: string;
  heatNumber: number;
  type: string;
  /** For called heats: when the checkin-cron fired. Undefined for upcoming. */
  calledAt?: string;
}

function trackSlugToResource(slug: string | null): (typeof TRACK_RESOURCES)[number] | null {
  if (!slug) return null;
  const s = slug.toLowerCase();
  if (s === "blue" || s === "blue-track") return "Blue Track";
  if (s === "red" || s === "red-track") return "Red Track";
  if (s === "mega" || s === "mega-track") return "Mega Track";
  return null;
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
    const resource = trackSlugToResource(searchParams.get("track"));
    if (!resource) {
      return NextResponse.json({ error: "track is required (blue|red|mega)" }, { status: 400 });
    }
    const beforeN = Math.max(1, Math.min(10, parseInt(searchParams.get("before") || "4", 10) || 4));
    const afterN = Math.max(1, Math.min(10, parseInt(searchParams.get("after") || "3", 10) || 3));

    // Build one Pandora window wide enough for both halves: yesterday
    // through tomorrow. This covers called races (scheduled today) AND
    // upcoming (scheduled today/tomorrow).
    const nowMs = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    const startWindow = new Date(nowMs - dayMs);
    startWindow.setUTCHours(0, 0, 0, 0);
    const endWindow = new Date(nowMs + 2 * dayMs);
    endWindow.setUTCHours(0, 0, 0, 0);

    // Fire the two independent reads in parallel.
    const [smsLog, pandoraList] = await Promise.all([
      readSmsLog(todayETYmd(), { limit: 2000, offset: 0 }),
      (async () => {
        const qs = new URLSearchParams({
          locationId: FASTTRAX_LOCATION_ID,
          resourceName: resource,
          startDate: startWindow.toISOString(),
          endDate: endWindow.toISOString(),
        }).toString();
        const res = await fetch(`${BASE}/api/pandora/sessions?${qs}`, { cache: "no-store" });
        if (!res.ok) return [] as PandoraSession[];
        const data = await res.json();
        return Array.isArray(data?.data) ? (data.data as PandoraSession[]) : [];
      })(),
    ]);

    const pandoraById = new Map<string, PandoraSession>(
      pandoraList.map((s) => [String(s.sessionId), s]),
    );

    // CALLED (from SMS log, filter to checkin-cron for this track).
    const firstSeen = new Map<string, string>(); // sessionId → ts
    for (const e of smsLog) {
      if (e.source !== "checkin-cron") continue;
      for (const sid of e.sessionIds ?? []) {
        const key = String(sid);
        if (firstSeen.has(key)) continue;
        // Only include sessions that belong to the requested track.
        // We check via Pandora's session list — if a session isn't in
        // the track's window, skip.
        if (!pandoraById.has(key)) continue;
        firstSeen.set(key, e.ts);
      }
    }

    const called: HeatEntry[] = [];
    for (const [sid, ts] of firstSeen.entries()) {
      const p = pandoraById.get(sid);
      if (!p) continue;
      called.push({
        sessionId: p.sessionId,
        name: p.name,
        scheduledStart: p.scheduledStart,
        track: resource,
        heatNumber: p.heatNumber,
        type: p.type,
        calledAt: ts,
      });
    }
    called.sort((a, b) => new Date(b.calledAt!).getTime() - new Date(a.calledAt!).getTime());
    const calledTop = called.slice(0, beforeN);

    // UPCOMING (from Pandora, scheduledStart > now).
    const upcoming: HeatEntry[] = pandoraList
      .filter((s) => new Date(s.scheduledStart).getTime() > nowMs)
      .sort((a, b) => new Date(a.scheduledStart).getTime() - new Date(b.scheduledStart).getTime())
      .slice(0, afterN)
      .map((s) => ({
        sessionId: s.sessionId,
        name: s.name,
        scheduledStart: s.scheduledStart,
        track: resource,
        heatNumber: s.heatNumber,
        type: s.type,
      }));

    return NextResponse.json(
      { called: calledTop, upcoming },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    console.error("[camera-assign/heats]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "failed to list heats" },
      { status: 500 },
    );
  }
}
