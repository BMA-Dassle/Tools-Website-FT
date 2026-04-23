import { NextRequest, NextResponse } from "next/server";

/**
 * GET /api/admin/camera-assign/upcoming
 *
 * Query params:
 *   track=blue|red|mega   required — scoped to one resource
 *   limit=N               default 3, max 10
 *
 * Returns the next N Pandora sessions with scheduledStart > now, sorted
 * ascending (soonest first). Used to populate the '+1 +2 +3' context
 * pills on the camera-assign page so staff can pre-assign cameras
 * before the check-in cron calls the race.
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

function trackSlugToResource(slug: string | null): (typeof TRACK_RESOURCES)[number] | null {
  if (!slug) return null;
  const s = slug.toLowerCase();
  if (s === "blue" || s === "blue-track") return "Blue Track";
  if (s === "red" || s === "red-track") return "Red Track";
  if (s === "mega" || s === "mega-track") return "Mega Track";
  return null;
}

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const trackParam = searchParams.get("track");
    const resource = trackSlugToResource(trackParam);
    if (!resource) {
      return NextResponse.json({ error: "track is required (blue|red|mega)" }, { status: 400 });
    }
    const limit = Math.max(1, Math.min(10, parseInt(searchParams.get("limit") || "3", 10) || 3));

    // Today + tomorrow window. Pandora may not publish beyond ~24h so
    // we stop there to keep the fetch light.
    const nowMs = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    const start = new Date(nowMs);
    start.setUTCHours(0, 0, 0, 0);
    const end = new Date(nowMs + 2 * dayMs);
    end.setUTCHours(0, 0, 0, 0);

    const qs = new URLSearchParams({
      locationId: FASTTRAX_LOCATION_ID,
      resourceName: resource,
      startDate: start.toISOString(),
      endDate: end.toISOString(),
    }).toString();
    const res = await fetch(`${BASE}/api/pandora/sessions?${qs}`, { cache: "no-store" });
    if (!res.ok) {
      return NextResponse.json({ error: `Pandora returned ${res.status}` }, { status: 502 });
    }
    const data = await res.json();
    const list: PandoraSession[] = Array.isArray(data?.data) ? data.data : [];

    const upcoming = list
      .filter((s) => new Date(s.scheduledStart).getTime() > nowMs)
      .sort((a, b) => new Date(a.scheduledStart).getTime() - new Date(b.scheduledStart).getTime())
      .slice(0, limit)
      .map((s) => ({
        sessionId: s.sessionId,
        name: s.name,
        scheduledStart: s.scheduledStart,
        track: resource,
        heatNumber: s.heatNumber,
        type: s.type,
      }));

    return NextResponse.json(
      { sessions: upcoming },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    console.error("[camera-assign/upcoming]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "failed to list upcoming" },
      { status: 500 },
    );
  }
}
