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
 * Three layers, mirroring the participants proxy:
 *
 * 1. Per-instance in-memory cache (60s) — protects against burst
 *    polling from the same Vercel function instance.
 * 2. Redis serving cache (30-min TTL), write-through on every
 *    successful Pandora fetch — survives cold starts and instance
 *    churn. Expires on purpose so a heat added mid-shift surfaces.
 * 3. Redis last-known-good (18h TTL), also written on success but
 *    read ONLY after a live fetch has failed. This is the floor that
 *    keeps a schedule on screen through a long vendor slowdown.
 *
 * The pre-race-tickets cron (every 2 min) already calls this
 * endpoint to enumerate upcoming heats, so during operating hours
 * the Redis cache stays continuously warm. Camera-assign reads
 * cache-first via `prefer=cache` for instant render even when
 * Pandora is hung.
 *
 * IMPORTANT: the cache key is built from the raw startDate/endDate
 * STRINGS. Callers that want to share the cron-warmed entry must send
 * the identical window shape (`${ymd}T00:00:00` .. `${ymd}T23:59:59`,
 * see lib/race-business-day.ts businessDayETRange). A caller inventing
 * its own window gets a private key nothing warms — which is how the
 * camera-assign heat picker ended up with no cache to fall back on.
 *
 * Abort timeouts on the upstream fetch: 6s for user-facing calls, 55s
 * for warm=1/fresh=1. Without them, browsers hung on Pandora's BMI
 * bridge and the camera-assign page wouldn't render at all.
 */

// Explicit ceiling so the 55s warm timeout has somewhere to land rather
// than depending on whatever the platform default happens to be.
export const maxDuration = 60;

const PANDORA_URL = "https://bma-pandora-api.azurewebsites.net/v2";
const API_KEY = process.env.SWAGGER_ADMIN_KEY || "";
const MEMORY_CACHE_TTL_MS = 60_000;
const REDIS_CACHE_TTL_SECONDS = 30 * 60; // 30 min — sessions for today rarely change post-publish
/**
 * Last-known-good TTL. The 30-min key above is the *serving* cache — it
 * expires on purpose so a heat added mid-shift shows up. The LKG copy is
 * the *floor*: written on every success, read only when a live fetch has
 * already failed, and long enough to cover a whole race night.
 *
 * Why it exists: on 2026-08-14 Pandora's /bmi/sessions answered 200 with
 * correct data but took 43-78s. Every 6s user-facing fetch aborted, the
 * 30-min key had lapsed, and the fallback had nothing to serve — so the
 * camera-assign heat picker went blank while the vendor was technically
 * "up". A slow upstream must degrade to a stale schedule, never to zero.
 */
const REDIS_LKG_TTL_SECONDS = 18 * 60 * 60; // 18h — spans a full race day

const ALLOWED_LOCATIONS = new Set([
  "LAB52GY480CJF", // FastTrax
  "TXBSQN0FEKQ11", // HeadPinz Fort Myers
  "PPTR5G2N0QXF7", // HeadPinz Naples
]);

// "Mega Track" is the canonical Pandora resource name for Tuesdays (the
// shorter "Mega" was a stale alias that returns 404 from /bmi/sessions).
// Keep "Mega" allowlisted for any old callers but Pandora only matches
// "Mega Track".
// "HP Arena" is the single CF_RSC_NAME covering BOTH Nexus Laser Tag and
// Nexus Gel Blaster sessions at HeadPinz FM (verified by live probe
// 2026-06-11 — "Nexus Laser Tag"/"Gel Blaster" variants all 404).
const ALLOWED_RESOURCES = new Set(["Blue Track", "Red Track", "Mega", "Mega Track", "HP Arena"]);

export interface PandoraSession {
  sessionId: string; // string per Pandora schema
  name: string; // e.g. "19 - Blue Junior Starter"
  scheduledStart: string; // ISO 8601 UTC
  type: string; // "Starter" | "Junior Starter" | "Intermediate" | "Pro" | "Intermediate (2)" etc.
  heatNumber: number;
  /** When the timing system actually started/ended the session (ISO UTC,
   *  explicit null until they happen). Added by Pandora 2026-07-08 — the
   *  resadmin VIP board derives race Done/On-track/Delayed from these.
   *  Same-day only; and actualEnd can occasionally fail to stamp, so
   *  consumers must not treat "actualStart without actualEnd" as on-track
   *  forever (see ~/features/reservations-admin/race-live-state). */
  actualStart?: string | null;
  actualEnd?: string | null;
}

const memoryCache: Map<string, { data: PandoraSession[]; expiry: number }> = new Map();

function cacheKey(
  locationId: string,
  resourceName: string,
  startDate: string,
  endDate: string,
): string {
  return `pandora:sessions:${locationId}:${resourceName}:${startDate}:${endDate}`;
}

/** Last-known-good twin of `cacheKey` — same identity, longer life. */
function lkgKey(memKey: string): string {
  return memKey.replace("pandora:sessions:", "pandora:sessions:lkg:");
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
    return NextResponse.json(
      { error: "Invalid resourceName (Blue Track / Red Track / Mega Track / HP Arena)" },
      { status: 400 },
    );
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
    //   cacheOnly=1 → last-known-good, else empty (never a Pandora call)
    //   prefer=cache → fall through to live Pandora below
    if (cacheOnly) {
      const lkg = await readRedisCache(lkgKey(memKey));
      if (lkg && lkg.length > 0) {
        return NextResponse.json(
          { data: lkg, cached: true, stale: true },
          { headers: { "X-Cache": "REDIS-LKG", "Cache-Control": "no-store" } },
        );
      }
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
  //   - warm=1 (cron) → 55s; no user waits, populates cache. Bumped
  //     30s → 45s after the 5/2 Pandora slowdown, then 45s → 55s on
  //     8/14 when session-list fetches were measured at 43-78s and the
  //     warmer itself was timing out — leaving nothing cached for the
  //     user-facing calls to fall back to. Stays inside the 60s
  //     maxDuration declared above.
  //   - fresh=1 (manual refresh button) → 55s; staff explicitly
  //     waiting, give Pandora time to land real data
  //   - default → 6s; background calls fail-fast onto the cache layers
  const timeoutMs = isWarmCall || forceFresh ? 55_000 : 6_000;

  async function fetchOnce(): Promise<
    { ok: true; data: PandoraSession[] } | { ok: false; status: number | null; body: string }
  > {
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
        body: isTimeout
          ? `timeout (>${timeoutMs / 1000}s, warm=${isWarmCall})`
          : err instanceof Error
            ? err.message
            : "fetch threw",
      };
    }
  }

  let attempt = await fetchOnce();
  // Retry once on 5xx / network failure. Don't retry 4xx — those are
  // our fault (auth, bad params) and won't get better.
  //
  // Never retry a long-mode timeout: 55s + 55s overruns the 60s
  // maxDuration and the function is killed mid-flight, so the cache
  // write we came here for never happens. Short-mode (6s) timeouts are
  // cheap enough to re-try.
  const timedOut = !attempt.ok && attempt.status == null && attempt.body.startsWith("timeout");
  const skipRetry = timedOut && (isWarmCall || forceFresh);
  if (!attempt.ok && !skipRetry && (attempt.status == null || attempt.status >= 500)) {
    await new Promise((r) => setTimeout(r, 250));
    attempt = await fetchOnce();
  }

  if (attempt.ok) {
    // Write-through: in-memory + Redis. Fire-and-forget on Redis so
    // a hiccup never blocks the response.
    memoryCache.set(memKey, { data: attempt.data, expiry: Date.now() + MEMORY_CACHE_TTL_MS });
    if (attempt.data.length > 0) {
      const payload = JSON.stringify(attempt.data);
      redis
        .set(memKey, payload, "EX", REDIS_CACHE_TTL_SECONDS)
        .catch((err) => console.warn("[sessions] redis write failed:", err));
      // Mirror into the long-lived floor. Only ever read after a live
      // failure, so a stale entry here can't shadow a fresh one.
      redis
        .set(lkgKey(memKey), payload, "EX", REDIS_LKG_TTL_SECONDS)
        .catch((err) => console.warn("[sessions] redis lkg write failed:", err));
    }
    return NextResponse.json(
      { data: attempt.data },
      { headers: { "X-Cache": "MISS", "Cache-Control": "no-store" } },
    );
  }

  console.error(
    `[sessions] Pandora ${attempt.status ?? "ERR"} for ${resourceName}: ${attempt.body}`,
  );

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
  // The 30-min serving key has lapsed too — fall to the last-known-good
  // floor. This is the layer that keeps a heat list on screen through a
  // multi-hour vendor slowdown.
  const lkg = await readRedisCache(lkgKey(memKey));
  if (lkg && lkg.length > 0) {
    memoryCache.set(memKey, { data: lkg, expiry: Date.now() + MEMORY_CACHE_TTL_MS });
    return NextResponse.json(
      { data: lkg, error: `Pandora ${attempt.status ?? "fetch failed"}`, stale: true },
      { status: 200, headers: { "X-Cache": "REDIS-LKG", "Cache-Control": "no-store" } },
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
    {
      status: 200,
      headers: {
        "X-Cache": memStale.length > 0 ? "MEM-STALE" : "ERROR",
        "Cache-Control": "no-store",
      },
    },
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
