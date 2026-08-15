import { NextRequest, NextResponse } from "next/server";
import { loadAllFromRedis, refreshRacesCurrent } from "~/features/racing/races-current.server";

/**
 * Proxy for Pandora's "currently called races per track" endpoint.
 *
 * GET /api/pandora/races-current
 *       (default)        — live Pandora first, fall back to the Redis carry
 *                           on failure. Used by /api/cron/checkin-alerts.
 *       &prefer=cache    — Redis-first, fall through to live Pandora only
 *                           when every track is empty. Guest-page polls.
 *       &cacheOnly=1     — Redis or empty; NEVER hits Pandora. Staff boards
 *                           and TVs — the races-current-warm loop keeps the
 *                           carry ~1-2s fresh, so this IS the realtime read.
 *       &warm=1          — 30s upstream timeout instead of 9s (warmers only).
 *
 * NO RESPONSE CACHE. The 12s in-memory cache that used to sit here is gone
 * (owner 2026-08-14: "Remove caching … for the session states — 1 second is
 * the minimums"): every request reads the Redis carry (3 GETs) or live
 * Pandora, and freshness is owned by the races-current-warm loop cron, which
 * refreshes the carry about once a second. Pandora is believed fixed (the
 * 5-40s responses behind the old ladder are gone) — and if it regresses,
 * browsers are on the carry, so the cost is staleness, never a frozen board.
 *
 * The merge itself (first-call pinning, desk-clear tombstones, the age-gated
 * between-heats carry) lives in ~/features/racing/races-current.server —
 * shared with the warm loop so the two can never disagree.
 */

const UPSTREAM_TIMEOUT_MS = 9_000;
const UPSTREAM_TIMEOUT_WARM_MS = 30_000;

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const preferCache = searchParams.get("prefer") === "cache";
  const cacheOnly = searchParams.get("cacheOnly") === "1";
  const warm = searchParams.get("warm") === "1";

  if (preferCache || cacheOnly) {
    const fromRedis = await loadAllFromRedis();
    const hasAny = fromRedis.blue !== null || fromRedis.red !== null || fromRedis.mega !== null;
    if (hasAny || cacheOnly) {
      return NextResponse.json(fromRedis, {
        headers: {
          "X-Cache": hasAny ? "REDIS-HIT" : "REDIS-MISS",
          "Cache-Control": "no-store",
        },
      });
    }
    // prefer=cache with an empty carry: fall through to live as a backstop.
  }

  const upstreamTimeoutMs = warm ? UPSTREAM_TIMEOUT_WARM_MS : UPSTREAM_TIMEOUT_MS;
  try {
    const merged = await refreshRacesCurrent(upstreamTimeoutMs);
    return NextResponse.json(merged, {
      headers: { "X-Cache": "MISS", "Cache-Control": "no-store" },
    });
  } catch (err) {
    const isTimeout = err instanceof Error && err.name === "AbortError";
    console.error(
      `[races-current] ${isTimeout ? `TIMEOUT (>${upstreamTimeoutMs}ms${warm ? ", warm" : ""})` : "fetch error"}:`,
      err,
    );
    // Live failed — serve the carry, age-gated, rather than nothing.
    const merged = await loadAllFromRedis();
    return NextResponse.json(merged, {
      headers: {
        "X-Cache": isTimeout ? "TIMEOUT-REDIS" : "ERROR-REDIS",
        "Cache-Control": "no-store",
      },
    });
  }
}
