import { NextRequest, NextResponse } from "next/server";
import redis from "@/lib/redis";
import { MAX_DISPLAY_AGE_MS, raceStillDisplayable } from "~/features/racing/current-race-freshness";

/**
 * Proxy for Pandora's "currently called races per track" endpoint.
 *
 * GET /api/pandora/races-current
 *       (default)        — live Pandora first, fall back to cache on failure.
 *                           Used by /api/cron/checkin-alerts every minute, which
 *                           is what keeps the Redis last-race-per-track keys warm.
 *       &prefer=cache    — Redis-first, fall through to live Pandora only when
 *                           every track is empty in Redis. Used by browser polls
 *                           (useTrackStatus on confirmation, e-tickets, etc.) so
 *                           ticket pages don't pay the 5s+ Pandora timeout
 *                           penalty when the upstream is hot.
 *       &cacheOnly=1     — Redis or empty; NEVER hits Pandora. Used by callers
 *                           that must render instantly with whatever's known and
 *                           let the next poll cycle fill in any gaps.
 *
 * Returns { blue, red, mega } — each is a CurrentRace object or null.
 *
 * Behavior:
 * - Pandora auto-expires its own entries 20 min after a heat is called. That
 *   makes tracks disappear from the UI during slow intervals between heats.
 * - We persist each track's last-known race to Redis and fall back to it when
 *   Pandora returns null, so the "Now Checking In" line stays visible between
 *   heats. That fallback is gated on the heat's AGE, not on opening hours — group
 *   events race before the doors open and their heats must display too (owner
 *   2026-08-11). See ~/features/racing/current-race-freshness.
 * - Server-side 12s in-memory cache layered on top: all browser clients share
 *   one Pandora fetch per cache window.
 * - Redis is kept continuously warm by the every-minute checkin-alerts cron,
 *   so `prefer=cache` reads are at most ~60s stale.
 */

const PANDORA_URL = "https://bma-pandora-api.azurewebsites.net/v2";
const API_KEY = process.env.SWAGGER_ADMIN_KEY || "";
const FASTTRAX_LOCATION_ID = "LAB52GY480CJF";
const CACHE_TTL_MS = 12_000;

type TrackKey = "blue" | "red" | "mega";

type CurrentRace = {
  trackName: string;
  raceType: string;
  heatNumber: number;
  scheduledStart?: string;
  calledAt: string;
  sessionId: number;
};

type CurrentRaces = Record<TrackKey, CurrentRace | null>;

// ── 12-second response cache (keeps Pandora fetches down) ───────────────────
let cached: { data: CurrentRaces; expiry: number } | null = null;

// ── Display freshness (NOT opening hours) ────────────────────────────────────
//
// This USED to gate on FastTrax's public opening hours, which broke group events:
// a private party's heat called at 1:30 PM on a Tuesday showed nowhere, because
// the doors do not open to the public until 3 (owner 2026-08-11). A called heat
// must display whenever it was called.
//
// What we actually care about is the heat's own AGE — see
// ~/features/racing/current-race-freshness, which is pure and unit-tested. The
// six-hour ceiling there matches what the old 5 AM cut-off already allowed at the
// end of a night, so this only ADDS the pre-open case; nothing lingers longer
// than it used to.

/** Seconds until midnight ET — used as Redis TTL for last-race storage. */
function secondsUntilEndOfDayET(): number {
  const now = Date.now();
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
    hour12: false,
  }).formatToParts(new Date());
  const h = parseInt(parts.find((p) => p.type === "hour")?.value || "0", 10);
  const m = parseInt(parts.find((p) => p.type === "minute")?.value || "0", 10);
  const s = parseInt(parts.find((p) => p.type === "second")?.value || "0", 10);
  const secSoFar = h * 3600 + m * 60 + s;
  const secRemaining = 86400 - secSoFar;
  // Cushion past midnight so a night's last heat is still readable into the small
  // hours. This must OUTLIVE the display window with room to spare — otherwise
  // the key quietly expires while the endpoint is still willing to serve it, and
  // the screens go blank for reasons nobody can see. Derived from
  // MAX_DISPLAY_AGE_MS rather than restated, so the two cannot drift: whatever
  // the freshness rule allows, the key survives an hour longer.
  const cushionSec = MAX_DISPLAY_AGE_MS / 1000 + 3600;
  return Math.max(60, secRemaining + cushionSec);
  // void now — kept for readability if we add timezone-debug logging later
  void now;
}

const REDIS_KEY = (t: TrackKey) => `pandora:last-race:fasttrax:${t}`;

async function saveRace(track: TrackKey, race: CurrentRace): Promise<void> {
  try {
    await redis.set(REDIS_KEY(track), JSON.stringify(race), "EX", secondsUntilEndOfDayET());
  } catch (err) {
    console.error(`[races-current] Redis save ${track}:`, err);
  }
}

/**
 * The stored last-known heat for a track, or null.
 *
 * THE FRESHNESS RULE LIVES HERE, in the one function every caller already goes
 * through — rather than at each of the three call sites, where the fourth one
 * added later would forget it.
 */
async function loadRace(track: TrackKey): Promise<CurrentRace | null> {
  try {
    const raw = await redis.get(REDIS_KEY(track));
    if (!raw) return null;
    const race = JSON.parse(raw) as CurrentRace;
    if (!raceStillDisplayable(race, Date.now())) return null;
    return race;
  } catch (err) {
    console.error(`[races-current] Redis load ${track}:`, err);
    return null;
  }
}

/** Read all three Redis last-race-per-track keys in parallel. Returns
 *  the same shape as a Pandora response, with `null` per track that
 *  has no warm entry. Cheap (3 GETs, ~5–20ms typical) compared to a
 *  live Pandora call (1–5s typical, 5s+ worst case). */
async function loadAllFromRedis(): Promise<CurrentRaces> {
  const [blue, red, mega] = await Promise.all([
    loadRace("blue"),
    loadRace("red"),
    loadRace("mega"),
  ]);
  return { blue, red, mega };
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  // prefer=cache → Redis-first; fall through to live Pandora only when
  // every track is empty in Redis. cacheOnly=1 → Redis or empty; never
  // hits Pandora. Mirrors the proven pattern on /api/pandora/sessions
  // and /api/pandora/session-participants. See file header.
  const preferCache = searchParams.get("prefer") === "cache";
  const cacheOnly = searchParams.get("cacheOnly") === "1";

  // Serve from in-memory cache if fresh — applies to ALL modes since
  // the cached value is always the most recent successful merge from
  // either Pandora or Redis. ~12s freshness window.
  if (cached && Date.now() < cached.expiry) {
    return NextResponse.json(cached.data, {
      headers: { "X-Cache": "HIT", "Cache-Control": "no-store" },
    });
  }

  // ── prefer=cache / cacheOnly=1 fast path ──────────────────────────
  // Skip the live Pandora call when the caller is OK with cache-warmed
  // data. Browser polls in useTrackStatus go through here so confirmation
  // / e-ticket pages never block on a slow Pandora fetch. The
  // checkin-alerts cron (every-minute, default mode) is the warmer.
  if (preferCache || cacheOnly) {
    // NO HOURS CHECK. Redis is read at any hour and each track is filtered by how
    // long ago its heat was called, so a group event before opening displays and
    // last night's finale does not.
    const fromRedis = await loadAllFromRedis();
    const hasAny = fromRedis.blue !== null || fromRedis.red !== null || fromRedis.mega !== null;
    if (hasAny) {
      // Redis has at least one track warm — return what we've got.
      // Memory-cache it so subsequent same-Lambda hits are even faster.
      cached = { data: fromRedis, expiry: Date.now() + CACHE_TTL_MS };
      return NextResponse.json(fromRedis, {
        headers: { "X-Cache": "REDIS-HIT", "Cache-Control": "no-store" },
      });
    }
    // Redis empty (cron hasn't warmed yet, or no heats called today).
    if (cacheOnly) {
      // Honor the no-Pandora contract — return empty. Caller will get
      // populated state on the next cron tick.
      return NextResponse.json(fromRedis, {
        headers: { "X-Cache": "REDIS-MISS", "Cache-Control": "no-store" },
      });
    }
    // prefer=cache: fall through to live Pandora below as a backstop.
  }

  // Hard timeout on the upstream Pandora fetch. Pandora has been
  // observed taking 20-40 SECONDS to respond when their service is
  // overloaded — without a timeout, every browser polling this
  // endpoint blocks for that long, fetches stack up in the renderer
  // tab, and Edge eventually kills it for memory ("This page
  // couldn't load"). Any request running longer than 5s falls
  // through to the fallback path below (last cached / Redis last-
  // known state). Keeps the proxy snappy regardless of upstream
  // health.
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5_000);

  try {
    const res = await fetch(`${PANDORA_URL}/bmi/races/current/${FASTTRAX_LOCATION_ID}`, {
      headers: { Authorization: `Bearer ${API_KEY}`, Accept: "application/json" },
      cache: "no-store",
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    const pandora: CurrentRaces = res.ok
      ? ((await res.json()).data ?? { blue: null, red: null, mega: null })
      : { blue: null, red: null, mega: null };

    // For each track: if Pandora has fresh data, save to Redis. If null,
    // fall back to the last-saved copy, which loadRace age-gates.
    const tracks: TrackKey[] = ["blue", "red", "mega"];
    const merged: CurrentRaces = { blue: null, red: null, mega: null };
    for (const t of tracks) {
      if (pandora[t]) {
        merged[t] = pandora[t];
        // Fire and forget — don't block response on Redis write
        saveRace(t, pandora[t] as CurrentRace);
      } else {
        // Pandora expires its own entry ~20 min after the call, so the stored
        // copy is what carries a session between heats. Age-gated, not
        // hours-gated.
        merged[t] = await loadRace(t);
      }
    }

    cached = { data: merged, expiry: Date.now() + CACHE_TTL_MS };
    return NextResponse.json(merged, {
      headers: { "X-Cache": "MISS", "Cache-Control": "no-store" },
    });
  } catch (err) {
    clearTimeout(timeoutId);
    // Distinguish "Pandora was slow" from "Pandora errored" in logs
    // so we can tell from the dashboard whether the timeout is
    // firing too aggressively.
    const isTimeout = err instanceof Error && err.name === "AbortError";
    console.error(`[races-current] ${isTimeout ? "TIMEOUT (>5s)" : "fetch error"}:`, err);

    // Fall back through layers: in-memory cache → Redis last-known
    // state per track (age-gated by loadRace).
    if (cached) {
      return NextResponse.json(cached.data, {
        headers: { "X-Cache": isTimeout ? "TIMEOUT" : "ERROR", "Cache-Control": "no-store" },
      });
    }
    const tracks: TrackKey[] = ["blue", "red", "mega"];
    const merged: CurrentRaces = { blue: null, red: null, mega: null };
    for (const t of tracks) merged[t] = await loadRace(t);
    return NextResponse.json(merged, {
      headers: {
        "X-Cache": isTimeout ? "TIMEOUT-REDIS" : "ERROR-REDIS",
        "Cache-Control": "no-store",
      },
    });
  }
}
