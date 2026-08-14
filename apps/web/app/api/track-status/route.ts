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
 *   6. Upstream timeout / non-2xx → fall back to the last known cache
 *      so the widget keeps showing something instead of blanking out,
 *      up to MAX_SERVE_AGE_MS (past that we genuinely don't know, and
 *      a stale delay figure is worse than none — see below)
 *
 * Hooks/components consuming this:
 *   - hooks/useTrackStatus.ts  (powers <TrackStatus /> on home/racing
 *                                + every e-ticket / group e-ticket)
 */

const UPSTREAM = "https://tools-track-status.vercel.app/api/v1/status";
const CACHE_KEY = "track-status:cache:v1";
const LOCK_KEY = "track-status:lock";

// Freshness — when we go back to upstream. Independent of retention.
const FRESH_MS = 30_000;

// Hard ceiling on the upstream call. Without one, a hung upstream pins
// the lock holder for the whole function duration (2026-08-13: upstream
// stopped answering entirely and we measured >20s with no response).
// When it's healthy it answers in well under a second, so any budget in
// the 8-15s band detects the outage identically; 10s keeps the unlucky
// request that holds the lock comfortably inside the client's 20s poll
// cycle.
const UPSTREAM_TIMEOUT_MS = 10_000;

// MUST exceed UPSTREAM_TIMEOUT_MS. At the old 5s the lock expired while
// its holder was still waiting on a hung upstream, so a second instance
// acquired it and hung too — the stampede protection dropped out at
// exactly the moment it was needed, adding a hanging fetch every 5s to
// an upstream already in trouble.
const LOCK_TTL_SEC = 15;

// RETENTION, not freshness. This was 60s, which is what actually caused
// the 503 storm: once upstream had been down for a minute Redis evicted
// the key, so `cached` was null on every path and the fallback promised
// above had nothing to fall back TO. An outage must not be able to
// delete our last known good value.
const CACHE_TTL_SEC = 3600;

// How stale a reading we're willing to state. There is no free answer
// here: track delay turns over with each heat (~12 min), so an old
// reading is read by a guest as current — but a hidden widget tells
// them nothing at all.
//
// Shipped at 10 min and that was too tight. Measured live during the
// 2026-08-13 outage: the cached reading aged out mid-outage and the
// widget went dark on the home page, racing page and every e-ticket
// while upstream stayed unreachable — trading a slightly-wrong number
// for no number, which is the worse end of the trade at this duration
// (owner call, same night).
//
// 45 min covers an outage of the length we actually saw. Past it the
// widget still hides, because by then the reading predates roughly
// four heats and is not worth stating.
const MAX_SERVE_AGE_MS = 45 * 60_000;

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

/** Returns our lock token if we won the race, else null. */
async function tryAcquireLock(): Promise<string | null> {
  const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    const ok = await redis.set(LOCK_KEY, token, "EX", LOCK_TTL_SEC, "NX");
    return ok === "OK" ? token : null;
  } catch {
    return null;
  }
}

// Compare-and-delete, atomically. A blind DEL is only safe while no
// holder can outlive LOCK_TTL_SEC — and a slow upstream is exactly the
// case where one does. Once our lock has expired and another instance
// has legitimately taken it, deleting it frees THEIR lock and invites a
// third instance to pile onto an upstream we already know is struggling.
const RELEASE_IF_MINE = `
  if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("del", KEYS[1])
  end
  return 0
`;

async function releaseLock(token: string): Promise<void> {
  try {
    await redis.eval(RELEASE_IF_MINE, 1, LOCK_KEY, token);
  } catch {
    /* ignore */
  }
}

/** Serve a cached reading, tagging how we arrived at it. */
function serveCached(
  entry: CachedEntry,
  cacheState: string,
  extra?: Record<string, string>,
): NextResponse {
  return NextResponse.json(entry.data, {
    headers: {
      "X-Cache": cacheState,
      "X-Cache-Age-Ms": String(Date.now() - entry.fetchedAt),
      "Cache-Control": "no-store",
      ...extra,
    },
  });
}

/** Stale is fine; ancient is a wrong answer stated confidently. */
function servable(entry: CachedEntry | null): entry is CachedEntry {
  return entry !== null && Date.now() - entry.fetchedAt <= MAX_SERVE_AGE_MS;
}

export async function GET() {
  // ── Hot path: serve fresh cache ─────────────────────────────────────
  const cached = await readCache();
  const ageMs = cached ? Date.now() - cached.fetchedAt : Infinity;
  if (cached && ageMs < FRESH_MS) {
    return serveCached(cached, "HIT");
  }

  // ── Slow path: cache stale (or missing). Try to be the one fetcher. ─
  const lockToken = await tryAcquireLock();

  if (!lockToken) {
    // Someone else is fetching — return what we have (even stale)
    // rather than dog-pile upstream.
    if (servable(cached)) return serveCached(cached, "STALE-LOCKED");

    // Nothing servable + can't get the lock → give the holder a moment
    // and look again; it may have just written a fresh value.
    await new Promise((r) => setTimeout(r, 250));
    const retried = await readCache();
    if (servable(retried)) return serveCached(retried, "WAITED");

    return NextResponse.json(
      { error: "track-status warming up" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }

  // We hold the lock — fetch upstream, bounded.
  try {
    const res = await fetch(`${UPSTREAM}?_t=${Date.now()}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`upstream ${res.status}`);
    const data = await res.json();
    await writeCache(data);
    return NextResponse.json(data, {
      headers: { "X-Cache": "MISS", "Cache-Control": "no-store" },
    });
  } catch (err) {
    const reason = (err instanceof Error ? err.message : "fetch failed").slice(0, 100);
    // Upstream failed — serve the last known reading if it's recent
    // enough to still mean something, else say so.
    if (servable(cached)) {
      return serveCached(cached, "STALE-ERROR", { "X-Upstream-Error": reason });
    }
    return NextResponse.json(
      { error: reason },
      { status: 502, headers: { "Cache-Control": "no-store" } },
    );
  } finally {
    await releaseLock(lockToken);
  }
}
