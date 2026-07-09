/**
 * Server-side fetchers for live race-session truth (Pandora actualStart/
 * actualEnd + the races-current watermark). Extracted verbatim from
 * app/api/admin/bowling/reservations/route.ts so the race-dayof-pay cron can
 * share them — the pure derivation stays in ./race-live-state.
 *
 * Consumers: the admin reservations board (raceState pills) and the
 * race-dayof-pay settle gate. Both are best-effort readers: every failure
 * path returns null/empty and the caller falls back to clock behavior.
 */
import redis from "@/lib/redis";
import type { TrackKey, TrackSession, TrackWatermark } from "./race-live-state";

const PANDORA_URL = "https://bma-pandora-api.azurewebsites.net/v2";
const PANDORA_KEY = process.env.SWAGGER_ADMIN_KEY || "";
const FASTTRAX_LOCATION_ID = "LAB52GY480CJF";
export const TRACK_RESOURCE: Record<TrackKey, string> = {
  blue: "Blue Track",
  red: "Red Track",
  mega: "Mega Track",
};

/** Per-track session-list cache. 30s: actualStart/actualEnd change constantly
 *  (unlike heat times), so this stays shorter than the 60s liveHeat TTL —
 *  combined with the sessions proxy's 2-min cron warm, a Done flip reaches
 *  the board in ~2-3 min worst case. Failures cache 30s so a Pandora outage
 *  can't hammer. */
const trackSessionCache = new Map<string, { sessions: TrackSession[] | null; expiry: number }>();

export async function fetchTrackSessions(
  track: TrackKey,
  ymd: string,
): Promise<TrackSession[] | null> {
  const resource = TRACK_RESOURCE[track];
  const memKey = `${resource}:${ymd}`;
  const cached = trackSessionCache.get(memKey);
  if (cached && Date.now() < cached.expiry) return cached.sessions;
  let sessions: TrackSession[] | null = null;
  // 1. Redis cache written by the sessions proxy — pre-race-tickets warms it
  //    every 2 min during operating hours. Key format MUST mirror
  //    app/api/pandora/sessions/route.ts cacheKey + the cron's todayETRange.
  try {
    const raw = await redis.get(
      `pandora:sessions:${FASTTRAX_LOCATION_ID}:${resource}:${ymd}T00:00:00:${ymd}T23:59:59`,
    );
    if (raw) {
      const parsed = JSON.parse(raw) as TrackSession[];
      if (Array.isArray(parsed) && parsed.length) sessions = parsed;
    }
  } catch {
    /* fall through to live */
  }
  // 2. Direct Pandora read (cache cold — e.g. before the cron's first warm).
  if (!sessions && PANDORA_KEY) {
    try {
      const qs = new URLSearchParams({
        startDate: `${ymd}T00:00:00`,
        endDate: `${ymd}T23:59:59`,
        resourceName: resource,
      });
      const res = await fetch(`${PANDORA_URL}/bmi/sessions/${FASTTRAX_LOCATION_ID}?${qs}`, {
        headers: { Authorization: `Bearer ${PANDORA_KEY}`, Accept: "application/json" },
        cache: "no-store",
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        const json = await res.json();
        if (Array.isArray(json?.data)) sessions = json.data as TrackSession[];
      }
    } catch {
      /* non-fatal — heats keep clock behavior */
    }
  }
  trackSessionCache.set(memKey, { sessions, expiry: Date.now() + 30_000 });
  return sessions;
}

/** Last-called race per track — the races-current proxy persists every call
 *  it sees to these keys (TTL end of day, warmed every minute by
 *  checkin-alerts). Sanity/fallback layer for the actual* timestamps. */
export async function fetchTrackWatermarks(): Promise<Partial<Record<TrackKey, TrackWatermark>>> {
  const tracks: TrackKey[] = ["blue", "red", "mega"];
  const out: Partial<Record<TrackKey, TrackWatermark>> = {};
  try {
    const vals = await redis.mget(...tracks.map((t) => `pandora:last-race:fasttrax:${t}`));
    tracks.forEach((t, i) => {
      const raw = vals[i];
      if (!raw) return;
      try {
        const r = JSON.parse(raw) as {
          sessionId?: number | string;
          heatNumber?: number;
          calledAt?: string;
        };
        if (r && typeof r.heatNumber === "number" && r.sessionId != null) {
          out[t] = { sessionId: r.sessionId, heatNumber: r.heatNumber, calledAt: r.calledAt ?? "" };
        }
      } catch {
        /* skip malformed entry */
      }
    });
  } catch {
    /* non-fatal — derivation falls back to actual* fields only */
  }
  return out;
}
