import { NextRequest, NextResponse } from "next/server";
import redis from "@/lib/redis";

/**
 * GET /api/admin/camera-assign/day?track=blue|red|mega&date=YYYY-MM-DD
 *
 * Returns every session for the given track on the given ET day,
 * sorted by scheduledStart ascending, with per-session assignment
 * counts pulled from Redis. Powers the "full day schedule" view on
 * the camera-assign page — replaces the older ±3 called + ±3
 * upcoming pills + Earlier modal with one scrollable list.
 *
 * If `date` is omitted we default to today ET.
 *
 * Auth: middleware.ts gates /api/admin/camera-assign/* on
 * ADMIN_CAMERA_TOKEN.
 */

const BASE = process.env.NEXT_PUBLIC_SITE_URL || "https://fasttraxent.com";
const FASTTRAX_LOCATION_ID = "LAB52GY480CJF";

type TrackSlug = "blue" | "red" | "mega";
const TRACK_RESOURCE: Record<TrackSlug, string> = {
  blue: "Blue Track",
  red: "Red Track",
  mega: "Mega Track",
};

interface PandoraSession {
  sessionId: string;
  name: string;
  scheduledStart: string; // ISO UTC
  type: string;
  heatNumber: number;
}

function etYmdNow(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}

/**
 * Compute a UTC window that fully covers the given ET calendar day.
 * ET is UTC-4 (EDT, Mar-Nov) or UTC-5 (EST). Querying ±1 day around
 * midnight UTC of `date` captures the whole ET day regardless of DST,
 * then we filter precisely on the client side via `etYmd` match.
 */
function etDayWindow(ymd: string): { startDate: string; endDate: string } {
  const [y, m, d] = ymd.split("-").map(Number);
  // Midnight ET is 04:00 UTC during EDT or 05:00 UTC during EST;
  // query a generous window and filter on the return.
  const start = new Date(Date.UTC(y, m - 1, d - 1, 0, 0, 0));
  const end = new Date(Date.UTC(y, m - 1, d + 1, 23, 59, 59));
  return { startDate: start.toISOString(), endDate: end.toISOString() };
}

function etYmdOf(iso: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date(iso));
}

async function fetchSessionsForResource(
  resourceName: string,
  startDate: string,
  endDate: string,
): Promise<PandoraSession[]> {
  const qs = new URLSearchParams({
    locationId: FASTTRAX_LOCATION_ID,
    resourceName,
    startDate,
    endDate,
  }).toString();
  const res = await fetch(`${BASE}/api/pandora/sessions?${qs}`, { cache: "no-store" });
  if (!res.ok) return [];
  const data = await res.json();
  return Array.isArray(data?.data) ? (data.data as PandoraSession[]) : [];
}

/**
 * How many racers are camera-bound for this session. The camera-assign
 * route keeps a Redis set `camera-assign:session:{sessionId}` with one
 * personId per assignment; SCARD = count. Missing set → 0.
 */
async function assignedCountFor(sessionId: string | number): Promise<number> {
  try {
    return await redis.scard(`camera-assign:session:${sessionId}`);
  } catch {
    return 0;
  }
}

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const trackRaw = (searchParams.get("track") || "").toLowerCase() as TrackSlug;
    const date = (searchParams.get("date") || etYmdNow()).trim();

    if (!TRACK_RESOURCE[trackRaw]) {
      return NextResponse.json({ error: "track must be blue|red|mega" }, { status: 400 });
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return NextResponse.json({ error: "date must be YYYY-MM-DD" }, { status: 400 });
    }

    const resource = TRACK_RESOURCE[trackRaw];
    const { startDate, endDate } = etDayWindow(date);
    const raw = await fetchSessionsForResource(resource, startDate, endDate);

    // Strict ET-day filter — the Pandora window is padded by a day on
    // each side to survive DST, so we clamp here.
    const sameDay = raw.filter((s) => etYmdOf(s.scheduledStart) === date);
    sameDay.sort((a, b) =>
      new Date(a.scheduledStart).getTime() - new Date(b.scheduledStart).getTime(),
    );

    // Fetch assignment counts in parallel. Cap at ~60 concurrent
    // Redis calls — Upstash handles this fine, and a normal race day
    // is 30-40 heats.
    const counts = await Promise.all(sameDay.map((s) => assignedCountFor(s.sessionId)));

    const nowMs = Date.now();
    const out = sameDay.map((s, i) => {
      const startMs = new Date(s.scheduledStart).getTime();
      // Derive lightweight status so the client doesn't need to
      // re-compute per-render. "called" is whatever checkin-cron
      // most recently fired for; the client already loads that feed
      // separately (and can overlay this flag) — we compute a rough
      // "past/live/upcoming" here based purely on scheduled time.
      let status: "past" | "live" | "upcoming" = "upcoming";
      if (startMs < nowMs - 15 * 60 * 1000) status = "past";
      else if (startMs < nowMs + 5 * 60 * 1000) status = "live";
      return {
        sessionId: s.sessionId,
        name: s.name,
        scheduledStart: s.scheduledStart,
        heatNumber: s.heatNumber,
        type: s.type,
        track: resource,
        assignedCount: counts[i] || 0,
        status,
      };
    });

    return NextResponse.json(
      { date, track: trackRaw, count: out.length, sessions: out },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    console.error("[camera-assign/day]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to load day" },
      { status: 500 },
    );
  }
}
