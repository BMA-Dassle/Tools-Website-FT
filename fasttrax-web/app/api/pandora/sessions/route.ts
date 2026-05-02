import { NextRequest, NextResponse } from "next/server";
import redis from "@/lib/redis";

/**
 * Proxy for Pandora's sessions-list endpoint.
 *
 *   GET /api/pandora/sessions?locationId=LAB52GY480CJF&startDate=...&endDate=...&resourceName=Blue%20Track
 *       &prefer=cache  — Redis-first, fall through to live Pandora on miss
 *                         (camera-assign auto-poll uses this for instant render)
 *       &fresh=1       — bypass cache entirely, force live Pandora call
 *                         (camera-assign refresh button)
 *
 * Upstream: GET /bmi/sessions/{locationID}?startDate&endDate&resourceName
 *
 * Response: { success, data: [{ sessionId, name, scheduledStart, type, heatNumber }] }
 *
 * ── Caching ─────────────────────────────────────────────────────────────────
 * Two layers, mirroring the participants proxy:
 *
 * 1. Per-instance in-memory cache (60s) — protects against burst
 *    polling from the same Vercel function instance.
 * 2. Redis write-through on every successful Pandora fetch (30-min
 *    TTL) — survives function cold starts and instance churn, and
 *    serves the failure-fallback when Pandora is degraded.
 *
 * The pre-race-tickets cron (every 2 min) already calls this
 * endpoint to enumerate upcoming heats, so during operating hours
 * the Redis cache stays continuously warm. Camera-assign reads
 * cache-first via `prefer=cache` for instant render even when
 * Pandora is hung.
 *
 * Hard 12s abort timeout on the upstream fetch — without it,
 * browsers hung on Pandora's BMI bridge during outages and the
 * camera-assign page wouldn't render at all.
 */

const PANDORA_URL = "https://bma-pandora-api.azurewebsites.net/v2";
const API_KEY = process.env.SWAGGER_ADMIN_KEY || "";
const MEMORY_CACHE_TTL_MS = 60_000;
const REDIS_CACHE_TTL_SECONDS = 30 * 60; // 30 min — sessions for today rarely change post-publish

const ALLOWED_LOCATIONS = new Set([
  "LAB52GY480CJF", // FastTrax
  "TXBSQN0FEKQ11", // HeadPinz Fort Myers
  "PPTR5G2N0QXF7", // HeadPinz Naples
]);

// "Mega Track" is the canonical Pandora resource name for Tuesdays (the
// shorter "Mega" was a stale alias that returns 404 from /bmi/sessions).
// Keep "Mega" allowlisted for any old callers but Pandora only matches
// "Mega Track".
const ALLOWED_RESOURCES = new Set(["Blue Track", "Red Track", "Mega", "Mega Track"]);

export interface PandoraSession {
  sessionId: string;         // string per Pandora schema
  name: string;              // e.g. "19 - Blue Junior Starter"
  scheduledStart: string;    // ISO 8601 UTC
  type: string;              // "Starter" | "Junior Starter" | "Intermediate" | "Pro" | "Intermediate (2)" etc.
  heatNumber: number;
}

const memoryCache: Map<string, { data: PandoraSession[]; expiry: number }> = new Map();

function cacheKey(locationId: string, resourceName: string, startDate: string, endDate: string): string {
  return `pandora:sessions:${locationId}:${resourceName}:${startDate}:${endDate}`;
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const locationId = searchParams.get("locationId");
  const startDate = searchParams.get("startDate");
  const endDate = searchParams.get("endDate");
  const resourceName = searchParams.get("resourceName");
  const preferCache = searchParams.get("prefer") === "cache";
  const forceFresh = searchParams.get("fresh") === "1";
  // cacheOnly=1 → return cache or empty, NEVER hit Pandora live.
  // Camera-assign auto-poll uses this so it never blocks waiting
  // for upstream — crons populate the cache, the page reads it.
  const cacheOnly = searchParams.get("cacheOnly") === "1";
  // Warm-mode opt-in for crons — see timeout block below.
  const isWarmCall = searchParams.get("warm") === "1";

  if (!locationId || !ALLOWED_LOCATIONS.has(locationId)) {
    return NextResponse.json({ error: "Invalid locationId" }, { status: 400 });
  }
  if (!startDate || !endDate) {
    return NextResponse.json({ error: "startDate and endDate required" }, { status: 400 });
  }
  if (!resourceName || !ALLOWED_RESOURCES.has(resourceName)) {
    return NextResponse.json({ error: "Invalid resourceName (Blue Track / Red Track / Mega Track)" }, { status: 400 });
  }

  const memKey = cacheKey(locationId, resourceName, startDate, endDate);

  // In-memory cache hit (always check unless forceFresh) — covers
  // burst polling from the same Vercel instance.
  if (!forceFresh) {
    const memHit = memoryCache.get(memKey);
    if (memHit && Date.now() < memHit.expiry) {
      return NextResponse.json(
        { data: memHit.data },
        { headers: { "X-Cache": "MEM-HIT", "Cache-Control": "no-store" } },
      );
    }
  }

  // Cache-first path (prefer=cache OR cacheOnly=1): Redis read
  // FIRST. cacheOnly=1 returns empty on miss (camera-assign
  // auto-poll uses this to never block on Pandora). prefer=cache
  // falls through to live Pandora on miss. Cron-warmed data is the
  // common case during operating hours.
  if ((preferCache || cacheOnly) && !forceFresh) {
    const redisData = await readRedisCache(memKey);
    if (redisData && redisData.length > 0) {
      // Promote to in-memory for subsequent calls in this instance.
      memoryCache.set(memKey, { data: redisData, expiry: Date.now() + MEMORY_CACHE_TTL_MS });
      return NextResponse.json(
        { data: redisData, cached: true },
        { headers: { "X-Cache": "REDIS-HIT", "Cache-Control": "no-store" } },
      );
    }
    // Cache miss handling:
    //   cacheOnly=1 → return empty immediately (no Pandora call)
    //   prefer=cache → fall through to live Pandora below
    if (cacheOnly) {
      return NextResponse.json(
        { data: [], cached: false, miss: true },
        { headers: { "X-Cache": "MISS-COLD", "Cache-Control": "no-store" } },
      );
    }
  }

  /**
   * Pandora's /bmi/sessions endpoint goes flaky during peak race
   * windows. Mitigations layered here:
   *  1. Hard 12s abort timeout on each upstream fetch — without it,
   *     a hung Pandora could hang the proxy for 60s+ until Vercel's
   *     function timeout fires, blocking the camera-assign page
   *     from rendering at all.
   *  2. Retry once on 5xx (or fetch throw) after 250ms back-off —
   *     usually clears transient glitches.
   *  3. On final failure, fall back to Redis cache → in-memory
   *     cache → empty.
   *  4. Surface upstream body slices in the JSON for debugging.
   */
  // Three-tier timeout (mirrors the participants proxy):
  //   - warm=1 (cron) → 45s; no user waits, populates cache. Bumped
  //     from 30s after the 5/2 Pandora slowdown — some session-list
  //     fetches were pushing past 30s and falling to stale cache.
  //     Stays inside Vercel's 60s function ceiling.
  //   - fresh=1 (manual refresh button) → 45s; staff explicitly
  //     waiting, give Pandora time to land real data
  //   - default → 6s; background calls fail-fast
  const timeoutMs = isWarmCall || forceFresh ? 45_000 : 6_000;

  async function fetchOnce(): Promise<{ ok: true; data: PandoraSession[] } | { ok: false; status: number | null; body: string }> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const upstreamQs = new URLSearchParams({
        startDate,
        endDate,
        resourceName,
      } as Record<string, string>).toString();
      const res = await fetch(`${PANDORA_URL}/bmi/sessions/${locationId}?${upstreamQs}`, {
        headers: {
          Authorization: `Bearer ${API_KEY}`,
          Accept: "application/json",
        },
        cache: "no-store",
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      if (!res.ok) {
        const body = (await res.text()).slice(0, 300);
        return { ok: false, status: res.status, body };
      }
      const json = await res.json();
      const data: PandoraSession[] = Array.isArray(json?.data) ? json.data : [];
      return { ok: true, data };
    } catch (err) {
      clearTimeout(timeoutId);
      const isTimeout = err instanceof Error && err.name === "AbortError";
      return {
        ok: false,
        status: null,
        body: isTimeout ? `timeout (>${timeoutMs / 1000}s, warm=${isWarmCall})` : (err instanceof Error ? err.message : "fetch threw"),
      };
    }
  }

  let attempt = await fetchOnce();
  // Retry once on 5xx / network failure. Don't retry 4xx — those are
  // our fault (auth, bad params) and won't get better.
  if (!attempt.ok && (attempt.status == null || attempt.status >= 500)) {
    await new Promise((r) => setTimeout(r, 250));
    attempt = await fetchOnce();
  }

  if (attempt.ok) {
    // Write-through: in-memory + Redis. Fire-and-forget on Redis so
    // a hiccup never blocks the response.
    memoryCache.set(memKey, { data: attempt.data, expiry: Date.now() + MEMORY_CACHE_TTL_MS });
    if (attempt.data.length > 0) {
      redis
        .set(memKey, JSON.stringify(attempt.data), "EX", REDIS_CACHE_TTL_SECONDS)
        .catch((err) => console.warn("[sessions] redis write failed:", err));
    }
    return NextResponse.json(
      { data: attempt.data },
      { headers: { "X-Cache": "MISS", "Cache-Control": "no-store" } },
    );
  }

  console.error(`[sessions] Pandora ${attempt.status ?? "ERR"} for ${resourceName}: ${attempt.body}`);

  // Fall back through cache layers: Redis first (survives instance
  // churn), then in-memory, then empty. Both are stale-but-real and
  // strictly better than zeroing out the heat list.
  const redisStale = await readRedisCache(memKey);
  if (redisStale && redisStale.length > 0) {
    memoryCache.set(memKey, { data: redisStale, expiry: Date.now() + MEMORY_CACHE_TTL_MS });
    return NextResponse.json(
      { data: redisStale, error: `Pandora ${attempt.status ?? "fetch failed"}`, stale: true },
      { status: 200, headers: { "X-Cache": "REDIS-STALE", "Cache-Control": "no-store" } },
    );
  }
  const memStale = memoryCache.get(memKey)?.data ?? [];
  return NextResponse.json(
    {
      data: memStale,
      error: `Pandora ${attempt.status ?? "fetch failed"}`,
      upstreamBody: attempt.body.slice(0, 200),
      stale: memStale.length > 0,
    },
    { status: 200, headers: { "X-Cache": memStale.length > 0 ? "MEM-STALE" : "ERROR", "Cache-Control": "no-store" } },
  );
}

async function readRedisCache(key: string): Promise<PandoraSession[] | null> {
  try {
    const raw = await redis.get(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PandoraSession[];
    return Array.isArray(parsed) ? parsed : null;
  } catch (err) {
    console.warn("[sessions] redis read failed:", err);
    return null;
  }
}
