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
import { parseWithRawIds } from "@ft/db";
import { resolveRaceLiveState, trackKeyFromName } from "./race-live-state";
import type { RaceLiveState, TrackKey, TrackSession, TrackWatermark } from "./race-live-state";

const PANDORA_URL = "https://bma-pandora-api.azurewebsites.net/v2";
const PANDORA_KEY = process.env.SWAGGER_ADMIN_KEY || "";
const FASTTRAX_LOCATION_ID = "LAB52GY480CJF";
export const TRACK_RESOURCE: Record<TrackKey, string> = {
  blue: "Blue Track",
  red: "Red Track",
  mega: "Mega Track",
};

/** Per-track session-list cache. 15s in-memory + the Redis fresh-claim below:
 *  ANY reader may refresh from Pandora, but a SET NX marker caps the whole
 *  fleet at one live read per track per 15s (owner 2026-08-11: "we can hit
 *  that endpoint every 15 seconds" — the 2-min cron warm alone made a Done
 *  flip take ~2-3 min to reach the welcome-back boards). Worst case now:
 *  ≤15s claim window + ≤15s memory TTL + the TV's 15s poll ≈ 45s, typically
 *  ~20-30s. Failures cache 15s so a Pandora outage can't hammer. */
const trackSessionCache = new Map<string, { sessions: TrackSession[] | null; expiry: number }>();

/** One live Pandora read per track per this many seconds, fleet-wide. */
const SESSIONS_FRESH_SECONDS = 15;
const SESSIONS_MEMORY_TTL_MS = 15_000;
/** Write-through TTL — MUST match app/api/pandora/sessions/route.ts
 *  REDIS_CACHE_TTL_SECONDS, since both write the same key. */
const SESSIONS_REDIS_TTL_SECONDS = 30 * 60;

export async function fetchTrackSessions(
  track: TrackKey,
  ymd: string,
): Promise<TrackSession[] | null> {
  const resource = TRACK_RESOURCE[track];
  const memKey = `${resource}:${ymd}`;
  const cached = trackSessionCache.get(memKey);
  if (cached && Date.now() < cached.expiry) return cached.sessions;
  let sessions: TrackSession[] | null = null;
  // 1. Redis cache — written by the sessions proxy (pre-race-tickets cron, every
  //    2 min) AND by the fresh-claim write-through below. Key format MUST mirror
  //    app/api/pandora/sessions/route.ts cacheKey + the cron's todayETRange.
  const redisKey = `pandora:sessions:${FASTTRAX_LOCATION_ID}:${resource}:${ymd}T00:00:00:${ymd}T23:59:59`;
  try {
    const raw = await redis.get(redisKey);
    if (raw) {
      const parsed = JSON.parse(raw) as TrackSession[];
      if (Array.isArray(parsed) && parsed.length) sessions = parsed;
    }
  } catch {
    /* fall through to live */
  }
  // 2. Freshness claim. The cron's 2-min warm is too slow for the end-of-session
  //    consumers (welcome-back board, return radio call), so readers refresh
  //    Pandora themselves — SET NX makes exactly one caller per track per window
  //    do the live read while everyone else rides the cache.
  let readLive = !sessions;
  if (!readLive && PANDORA_KEY) {
    try {
      const claim = await redis.set(
        `${redisKey}:fresh-claim`,
        "1",
        "EX",
        SESSIONS_FRESH_SECONDS,
        "NX",
      );
      readLive = claim === "OK";
    } catch {
      /* Redis flaky — the cached copy we just read is the safer answer */
    }
  }
  // 3. Live Pandora read (won the claim, or the cache was cold).
  if (readLive && PANDORA_KEY) {
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
        if (Array.isArray(json?.data)) {
          sessions = json.data as TrackSession[];
          // Write-through (non-empty only, mirroring the proxy) so every other
          // reader and the proxy's cache-first callers see this refresh too.
          if (sessions.length) {
            redis
              .set(redisKey, JSON.stringify(sessions), "EX", SESSIONS_REDIS_TTL_SECONDS)
              .catch(() => {});
          }
        }
      }
    } catch {
      /* non-fatal — the stale cache read above still stands */
    }
  }
  trackSessionCache.set(memKey, { sessions, expiry: Date.now() + SESSIONS_MEMORY_TTL_MS });
  return sessions;
}

/** Last-called race per track — the races-current proxy persists every call
 *  it sees to these keys (TTL end of day, warmed every minute by
 *  checkin-alerts). Powers ONLY the "called" state — the grid call runs 1-2
 *  heats ahead of the track, so it can never stand in for actual* truth. */
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

// ── Live BMI heat times per bill ─────────────────────────────────────────────
// Staff reschedule heats in BMI Office (and grid migrations move whole days),
// which makes the heat times stamped into booking_metadata at BOOKING time
// stale — live audit 2026-07-10: 21 of 107 booked heats no longer matched any
// Pandora session while the bills' CURRENT lines matched cleanly. The bill's
// public overview reflects the current session per line, so consumers (the
// admin board's combo cards AND the race-dayof-pay settle gate) prefer these
// times over metadata. Moved verbatim from the admin reservations route.
const BMI_API_URL = process.env.BMI_API_URL || "https://api.bmileisure.com";
const BMI_SUB_KEY = process.env.BMI_SUBSCRIPTION_KEY || "";
const BMI_USERNAME = process.env.BMI_USERNAME || "";
const BMI_PASSWORD = process.env.BMI_PASSWORD || "";
/** Race bills live under the FastTrax client key (combos are Fort Myers-only). */
const RACE_CLIENT_KEY = "headpinzftmyers";

let bmiTokenCache: { token: string; expiry: number } | null = null;
async function getBmiToken(): Promise<string> {
  if (bmiTokenCache && Date.now() < bmiTokenCache.expiry - 60_000) return bmiTokenCache.token;
  const res = await fetch(`${BMI_API_URL}/auth/${RACE_CLIENT_KEY}/publicbooking`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "BMI-Subscription-Key": BMI_SUB_KEY },
    body: JSON.stringify({ Username: BMI_USERNAME, Password: BMI_PASSWORD }),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`BMI auth ${res.status}`);
  const data = await res.json();
  const token = data.AccessToken || data.accessToken;
  const expiresIn = parseInt(data.ExpiresIn || data.expiresIn || "3600", 10);
  bmiTokenCache = { token, expiry: Date.now() + expiresIn * 1000 };
  return token;
}

export interface LiveHeat {
  /** Naive ET wall-clock ISO (same shape as booking_metadata heatIds). */
  start: string;
  /** REAL session end from BMI (~7-12 min after start) — the board flips a
   *  race to Done at this moment instead of guessing a duration. */
  stop: string | null;
  /** BMI line name, e.g. "Starter Race Blue" — the board labels from it. */
  name: string | null;
  /** Pandora session resolved by track + start minute (string per Pandora). */
  sessionId?: string;
  heatNumber?: number;
  /** Live track truth (Pandora actualStart/actualEnd + called watermark) —
   *  the board's Done / On-track / Delayed markers trust this over the clock,
   *  exactly like bowling trusts QAMF lane state. Absent = clock fallback. */
  raceState?: RaceLiveState;
  /** How many bill lines share this session — one line per racer, so this is
   *  the racer count for the heat (the manage modal shows "N racers"). */
  racers?: number;
}

/** In-memory per-bill cache: the board polls its route every 10s, so without
 *  a TTL every open admin tab would hit BMI per race leg per poll. 60s is
 *  fresh enough for an office reschedule; failures cache 30s so a BMI outage
 *  can't hammer. In-memory (not Redis) on purpose — warm lambdas cover the
 *  10s poll, and a cold-start miss is just one light GET per bill. */
const liveHeatCache = new Map<string, { heats: LiveHeat[] | null; expiry: number }>();

export async function fetchLiveHeats(billId: string): Promise<LiveHeat[] | null> {
  const cached = liveHeatCache.get(billId);
  if (cached && Date.now() < cached.expiry) return cached.heats;
  let heats: LiveHeat[] | null = null;
  try {
    const token = await getBmiToken();
    const res = await fetch(
      `${BMI_API_URL}/public-booking/${RACE_CLIENT_KEY}/order/${billId}/overview`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "BMI-Subscription-Key": BMI_SUB_KEY,
          "Accept-Language": "en",
        },
        cache: "no-store",
        signal: AbortSignal.timeout(5000),
      },
    );
    if (res.ok) {
      // Overview carries 17-digit ids — lossless parse only (never res.json()).
      const ov = parseWithRawIds<{
        lines?: Array<{
          name?: string;
          scheduledTime?: { start?: string; stop?: string };
          start?: string;
          stop?: string;
        }>;
      }>(await res.text());
      // Scheduled lines only — the race heats. POV/license lines have no
      // scheduledTime and drop out here. The bill carries ONE line per racer
      // per session — collapse to one heat per session and keep the line
      // count as the racer count.
      const bySession = new Map<string, LiveHeat>();
      for (const l of ov.lines ?? []) {
        const start = l.scheduledTime?.start ?? l.start ?? "";
        if (!start) continue;
        const k = `${start}|${l.name ?? ""}`;
        const cur = bySession.get(k);
        if (cur) {
          cur.racers = (cur.racers ?? 1) + 1;
        } else {
          bySession.set(k, {
            start,
            stop: l.scheduledTime?.stop ?? l.stop ?? null,
            name: l.name ?? null,
            racers: 1,
          });
        }
      }
      heats = [...bySession.values()].sort((a, b) => a.start.localeCompare(b.start));
    }
  } catch {
    /* non-fatal — callers fall back to booking_metadata heat times */
  }
  liveHeatCache.set(billId, { heats, expiry: Date.now() + (heats ? 60_000 : 30_000) });
  return heats;
}

/** Stamp raceState/sessionId onto every live heat of the given race legs.
 *  Same-day only (Pandora serves today; the pills only matter live).
 *  Best-effort — an unresolved heat keeps clock behavior on the board.
 *  Moved verbatim from the admin reservations route so the vip-move-alerts
 *  cron can share it. */
export async function attachRaceLiveState(
  raceLegs: Array<{ liveHeats?: LiveHeat[] }>,
  ymd: string,
): Promise<void> {
  const todayEt = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  if (ymd !== todayEt) return;
  const tracksNeeded = new Set<TrackKey>();
  for (const r of raceLegs)
    for (const h of r.liveHeats ?? []) {
      const t = trackKeyFromName(h.name);
      if (t) tracksNeeded.add(t);
    }
  if (!tracksNeeded.size) return;
  const trackList = [...tracksNeeded];
  const [watermarks, sessionLists] = await Promise.all([
    fetchTrackWatermarks(),
    Promise.all(trackList.map((t) => fetchTrackSessions(t, ymd))),
  ]);
  const sessionsByTrack = new Map<TrackKey, TrackSession[]>();
  trackList.forEach((t, i) => {
    const s = sessionLists[i];
    if (s) sessionsByTrack.set(t, s);
  });
  const nowMs = Date.now();
  for (const r of raceLegs)
    for (const h of r.liveHeats ?? []) {
      const t = trackKeyFromName(h.name);
      const sessions = t ? sessionsByTrack.get(t) : undefined;
      if (!t || !sessions) continue;
      const live = resolveRaceLiveState({
        heatStartIso: h.start,
        sessions,
        watermark: watermarks[t],
        nowMs,
      });
      if (live) {
        h.sessionId = live.sessionId;
        h.heatNumber = live.heatNumber;
        h.raceState = live.raceState;
      }
    }
}
