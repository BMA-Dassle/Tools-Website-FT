import { NextRequest, NextResponse } from "next/server";
import { readSmsLog } from "@/lib/sms-log";

/**
 * GET /api/admin/camera-assign/called
 *
 * Query params:
 *   track=blue|red|mega   optional — scope to one resource. If omitted,
 *                         returns called races across all three tracks.
 *   limit=N               default 3, max 10.
 *
 * Returns the last N "called" race sessions — where "called" means the
 * checkin-cron SMS went out for that session (the moment staff announces
 * the heat to staging + racers get their 10-min-out SMS).
 *
 * Source of truth: today's sms:log filtered to source='checkin-cron',
 * deduped by sessionId, sorted by ts descending. Cross-referenced with
 * Pandora's today-session list to populate track/type/heat number for
 * display.
 *
 * We DON'T sort by Pandora's scheduledStart because heat numbers at
 * FastTrax don't always correlate with time-of-day (heat 49 may have
 * physically run before heat 25 if the schedule was shuffled). The SMS
 * log's ts is the authoritative "when was this race called" clock.
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

interface CalledSession {
  sessionId: string | number;
  name: string;
  scheduledStart: string;
  track: string;       // "Blue Track" / "Red Track" / "Mega Track"
  heatNumber: number;
  type: string;
  calledAt: string;    // ISO — when the checkin-cron SMS went out
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

/**
 * Fetch today's full session list from Pandora (once per request,
 * across all 3 tracks) so we can enrich called sessionIds with
 * track/type/heat info.
 */
async function fetchTodaySessions(resources: readonly string[]): Promise<Map<string, PandoraSession & { resourceName: string }>> {
  const nowMs = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;
  // Wide window: 1 day back to 1 day forward captures any session that
  // might have been called today regardless of when it was scheduled.
  const start = new Date(nowMs - dayMs);
  start.setUTCHours(0, 0, 0, 0);
  const end = new Date(nowMs + dayMs);
  end.setUTCHours(0, 0, 0, 0);

  const results = await Promise.all(
    resources.map(async (r) => {
      const qs = new URLSearchParams({
        locationId: FASTTRAX_LOCATION_ID,
        resourceName: r,
        startDate: start.toISOString(),
        endDate: end.toISOString(),
      }).toString();
      const res = await fetch(`${BASE}/api/pandora/sessions?${qs}`, { cache: "no-store" });
      if (!res.ok) return [];
      const data = await res.json();
      const list: PandoraSession[] = Array.isArray(data?.data) ? data.data : [];
      return list.map((s) => ({ ...s, resourceName: r }));
    }),
  );

  const byId = new Map<string, PandoraSession & { resourceName: string }>();
  for (const s of results.flat()) byId.set(String(s.sessionId), s);
  return byId;
}

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const trackParam = searchParams.get("track");
    const requestedResource = trackSlugToResource(trackParam);
    const resources = requestedResource ? [requestedResource] : (TRACK_RESOURCES as readonly string[]);
    const limit = Math.max(1, Math.min(10, parseInt(searchParams.get("limit") || "3", 10) || 3));

    // 1. Read today's SMS log, filter to checkin-cron.
    const today = todayETYmd();
    const log = await readSmsLog(today, { limit: 2000, offset: 0 });
    const checkinEntries = log.filter((e) => e.source === "checkin-cron");

    // 2. Dedup by sessionId — keep the first occurrence since the log is
    //    already newest-first (LPUSH). One SMS entry may list multiple
    //    sessionIds if it was a grouped send.
    const firstSeen = new Map<string, string>(); // sessionId → ts
    for (const e of checkinEntries) {
      for (const sid of e.sessionIds ?? []) {
        const key = String(sid);
        if (!firstSeen.has(key)) firstSeen.set(key, e.ts);
      }
    }
    if (firstSeen.size === 0) {
      return NextResponse.json(
        { sessions: [], note: "No called races in the SMS log yet today." },
        { headers: { "Cache-Control": "no-store" } },
      );
    }

    // 3. Enrich with Pandora session metadata.
    const sessionsById = await fetchTodaySessions(resources);
    const enriched: CalledSession[] = [];
    for (const [sid, ts] of firstSeen.entries()) {
      const p = sessionsById.get(sid);
      if (!p) continue; // session not in the Pandora window (may be from a different resource than requested)
      if (requestedResource && p.resourceName !== requestedResource) continue;
      enriched.push({
        sessionId: p.sessionId,
        name: p.name,
        scheduledStart: p.scheduledStart,
        track: p.resourceName,
        heatNumber: p.heatNumber,
        type: p.type,
        calledAt: ts,
      });
    }

    // 4. Sort by calledAt desc (= most recently called first) and trim.
    enriched.sort((a, b) => new Date(b.calledAt).getTime() - new Date(a.calledAt).getTime());
    return NextResponse.json(
      { sessions: enriched.slice(0, limit) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    console.error("[camera-assign/called]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "failed to list called sessions" },
      { status: 500 },
    );
  }
}
