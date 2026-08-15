import { NextRequest, NextResponse } from "next/server";
import redis from "@/lib/redis";
import { businessDayYmdET } from "@/lib/race-business-day";

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

// "Today" = the racing business day (2 AM ET rollover) so a race night
// that runs past midnight keeps showing its full schedule. See
// lib/race-business-day.ts.
function etYmdNow(): string {
  return businessDayYmdET();
}

/**
 * The ET-local-string window for a day — `${ymd}T00:00:00` ..
 * `${ymd}T23:59:59`.
 *
 * This shape is NOT cosmetic. It is the exact string pair the
 * pre-race-tickets cron sends every 2 minutes, and the
 * /api/pandora/sessions Redis cache key is built from the raw
 * startDate/endDate strings. Any other window (we used to send a
 * padded ±1-day UTC ISO range) produces a key nothing ever warms —
 * so every request paid the live Pandora cost, and when Pandora
 * 500'd the stale-cache fallback had nothing to fall back TO and
 * the heat list came back empty. Keep this aligned with
 * businessDayETRange() in lib/race-business-day.ts.
 */
function etDayWindow(ymd: string): { startDate: string; endDate: string } {
  return { startDate: `${ymd}T00:00:00`, endDate: `${ymd}T23:59:59` };
}

function etYmdOf(iso: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso));
}

/**
 * Redis-first (`prefer=cache`), falling through to live Pandora on a
 * cold key. The day's heat list barely changes once published, and the
 * cron keeps the cache warm through operating hours — so cache-first is
 * both faster AND the thing that keeps the list on screen when Pandora
 * is throwing. The proxy's own failure path then serves the stale Redis
 * copy and flags `stale: true`, which we pass up to the operator.
 */
async function fetchSessionsForResource(
  resourceName: string,
  startDate: string,
  endDate: string,
): Promise<{ sessions: PandoraSession[]; stale: boolean }> {
  const qs = new URLSearchParams({
    locationId: FASTTRAX_LOCATION_ID,
    resourceName,
    startDate,
    endDate,
    prefer: "cache",
  }).toString();
  const res = await fetch(`${BASE}/api/pandora/sessions?${qs}`, { cache: "no-store" });
  if (!res.ok) return { sessions: [], stale: false };
  const data = await res.json();
  return {
    sessions: Array.isArray(data?.data) ? (data.data as PandoraSession[]) : [],
    stale: data?.stale === true,
  };
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
    const { sessions: raw, stale } = await fetchSessionsForResource(resource, startDate, endDate);

    // Belt-and-braces ET-day clamp. The window above is already ET-local
    // so this is normally a no-op — it only bites if Pandora ever widens
    // what it returns for a day range.
    const sameDay = raw.filter((s) => etYmdOf(s.scheduledStart) === date);
    sameDay.sort(
      (a, b) => new Date(a.scheduledStart).getTime() - new Date(b.scheduledStart).getTime(),
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
      { date, track: trackRaw, count: out.length, sessions: out, stale },
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
