import { NextResponse } from "next/server";
import redis from "@/lib/redis";

/**
 * Cached proxy for the BMA track-status service that drives the
 * "Live Track Status — On Time / +N Min" widget on the home page,
 * racing page, e-tickets, etc.
 *
 *   GET /api/track-status
 *
 * Upstream:
 *   GET https://tools-track-status.vercel.app/api/v1/status
 *
 * Caching strategy: Redis-backed, shared across all Vercel lambda
 * instances. One upstream call every ~30s no matter how many
 * concurrent client requests come in.
 *
 * Hot path:
 *   1. Read `track-status:cache:v1` from Redis
 *   2. If freshness age < 30s → serve immediately, no upstream call
 *
 * Slow path (cache stale or missing):
 *   3. Try to acquire `track-status:lock` (SET NX EX 5)
 *   4. If we got the lock → fetch upstream, write cache, release lock
 *   5. If we didn't (another instance is fetching) → serve whatever's
 *      in cache even if slightly stale, rather than dog-pile upstream
 *
 * Failure path:
 *   6. Upstream timeout / non-2xx → fall back to last known cache
 *      (any age) so the widget keeps showing something instead of
 *      blanking out
 *
 * Hooks/components consuming this:
 *   - hooks/useTrackStatus.ts  (powers <TrackStatus /> on home/racing
 *                                + every e-ticket / group e-ticket)
 */

const UPSTREAM = "https://tools-track-status.vercel.app/api/v1/status";
const CACHE_KEY = "track-status:cache:v1";
const LOCK_KEY = "track-status:lock";
const CACHE_TTL_SEC = 60;          // hold for a minute as a safety floor
const FRESH_MS = 30_000;           // re-fetch upstream when cache is older than this
const LOCK_TTL_SEC = 5;            // brief lock window for stampede prevention

interface CachedEntry {
  fetchedAt: number;
  data: unknown;
}

async function readCache(): Promise<CachedEntry | null> {
  try {
    const raw = await redis.get(CACHE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as CachedEntry;
  } catch {
    return null;
  }
}

async function writeCache(data: unknown): Promise<void> {
  try {
    await redis.set(
      CACHE_KEY,
      JSON.stringify({ fetchedAt: Date.now(), data }),
      "EX",
      CACHE_TTL_SEC,
    );
  } catch {
    /* best-effort */
  }
}

async function tryAcquireLock(): Promise<boolean> {
  try {
    const ok = await redis.set(LOCK_KEY, "1", "EX", LOCK_TTL_SEC, "NX");
    return ok === "OK";
  } catch {
    return false;
  }
}

async function releaseLock(): Promise<void> {
  try { await redis.del(LOCK_KEY); } catch { /* ignore */ }
}

export async function GET() {
  // ── Hot path: serve fresh cache ─────────────────────────────────────
  const cached = await readCache();
  const ageMs = cached ? Date.now() - cached.fetchedAt : Infinity;
  if (cached && ageMs < FRESH_MS) {
    return NextResponse.json(cached.data, {
      headers: {
        "X-Cache": "HIT",
        "X-Cache-Age-Ms": String(ageMs),
        "Cache-Control": "no-store",
      },
    });
  }

  // ── Slow path: cache stale (or missing). Try to be the one fetcher. ─
  const gotLock = await tryAcquireLock();

  if (!gotLock) {
    // Someone else is fetching — return what we have (even stale)
    // rather than dog-pile upstream.
    if (cached) {
      return NextResponse.json(cached.data, {
        headers: {
          "X-Cache": "STALE-LOCKED",
          "X-Cache-Age-Ms": String(ageMs),
          "Cache-Control": "no-store",
        },
      });
    }
    // No cache at all + can't get lock → wait briefly + try cache again
    await new Promise((r) => setTimeout(r, 250));
    const retried = await readCache();
    if (retried) {
      return NextResponse.json(retried.data, {
        headers: { "X-Cache": "WAITED", "Cache-Control": "no-store" },
      });
    }
    return NextResponse.json({ error: "track-status warming up" }, { status: 503 });
  }

  // We hold the lock — fetch upstream.
  try {
    const res = await fetch(`${UPSTREAM}?_t=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`upstream ${res.status}`);
    const data = await res.json();
    await writeCache(data);
    return NextResponse.json(data, {
      headers: { "X-Cache": "MISS", "Cache-Control": "no-store" },
    });
  } catch (err) {
    // Upstream failed — serve stale if we have any, else 502.
    if (cached) {
      return NextResponse.json(cached.data, {
        headers: {
          "X-Cache": "STALE-ERROR",
          "X-Cache-Age-Ms": String(ageMs),
          "X-Upstream-Error": (err instanceof Error ? err.message : "fetch failed").slice(0, 100),
          "Cache-Control": "no-store",
        },
      });
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "upstream failed" },
      { status: 502, headers: { "Cache-Control": "no-store" } },
    );
  } finally {
    await releaseLock();
  }
}
