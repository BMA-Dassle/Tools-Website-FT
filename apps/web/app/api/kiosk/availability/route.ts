import { NextRequest, NextResponse } from "next/server";
import redis from "@/lib/redis";
import {
  computeExperienceAvailability,
  type ExperienceAvailability,
  type ExperienceAvailabilityResult,
} from "~/features/kiosk/service/experience-availability";
import type { CenterCode } from "~/features/booking";

/**
 * Cached kiosk Experience availability. Kiosks poll this cheap endpoint; the
 * expensive BMI/QAMF feasibility runs SERVER-side and is cached in Redis so the
 * vendors are hit at most once per TTL per center — not once per kiosk poll.
 *
 * GET /api/kiosk/availability?center=fort-myers
 *   → { center, items: { "race-bowl": bool, ... }, firstOpen: { "duck-pin": { start, freeSpots }, ... } }
 *   `items` locks tiles; `firstOpen` feeds each tile's "3 lanes · 9:30 PM" line.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// A cache-miss compute fans out across BMI (racing + 4 attractions) and QAMF
// (bowling + KBF + the combo chain) — cold vendors can blow the default 10s.
export const maxDuration = 60;

const VALID_CENTERS: CenterCode[] = ["fort-myers", "naples"];
// Recompute at most once per 3 min per center. Dropped from 5 min (owner wants
// fresher tiles) — affordable because the QAMF lane scans now early-exit at the
// first bookable slot (firstOnly), so each recompute is far cheaper than before.
const TTL_SECONDS = 180;
// Bump the version whenever the cached SHAPE changes so a rollout never reads a
// stale entry: v2 added firstOpen; v3 adds race-bowl / ultimate-qualifier
// firstOpen (experiences "Next available · N slots").
const cacheKey = (c: string) => `kiosk:avail:v3:${c}`;

const DEFAULT_AVAILABLE: ExperienceAvailability = {
  "race-bowl": true,
  "ultimate-qualifier": true,
  bowling: true,
  kbf: true,
  race: true,
  "duck-pin": true,
  "gel-blaster": true,
  "laser-tag": true,
  "shuffly-fasttrax": true,
  "shuffly-headpinz": true,
};
const DEFAULT_RESULT: ExperienceAvailabilityResult = {
  available: DEFAULT_AVAILABLE,
  firstOpen: {},
};

// Per-instance single-flight so concurrent cache misses don't stampede vendors
// WITHIN one Lambda. The cross-INSTANCE guard is the Redis lock below — without
// it, every warm Lambda that gets a poll at the TTL boundary ran the full
// BMI/QAMF fan-out simultaneously (the burst that made BMI sluggish under load).
const inflight = new Map<string, Promise<ExperienceAvailabilityResult>>();

// Cross-instance single-flight lock. Held only for the duration of one compute;
// sized above a warm compute yet well under the cache TTL so a dead leader
// (crashed Lambda) self-heals within one lock window. Losers wait briefly for
// the leader's cached result, then fail open (DEFAULT_RESULT) — they NEVER run
// their own compute, so exactly one fan-out happens per center per TTL across
// the whole cluster, no matter how many kiosks poll.
const LOCK_MS = 45_000;
const WAIT_MS = 5_000; // max a loser blocks waiting for the leader's result
const WAIT_POLL_MS = 250;

function readCache(cached: string | null): ExperienceAvailabilityResult | null {
  if (!cached) return null;
  try {
    const parsed = JSON.parse(cached) as ExperienceAvailabilityResult;
    // Ignore anything missing the v2 `available` shape (defensive — the key
    // bump should already prevent an old flat-boolean entry here).
    return parsed?.available ? parsed : null;
  } catch {
    return null;
  }
}

/** Poll the cache for a value the lock leader is computing on another instance.
 *  Returns the parsed result once it lands, or null if it doesn't within WAIT_MS. */
async function waitForLeaderResult(key: string): Promise<ExperienceAvailabilityResult | null> {
  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, WAIT_POLL_MS));
    try {
      const hit = readCache(await redis.get(key));
      if (hit) return hit;
    } catch {
      return null; // Redis down — stop polling, caller fails open
    }
  }
  return null;
}

async function loadAvailability(center: CenterCode): Promise<ExperienceAvailabilityResult> {
  const key = cacheKey(center);

  // 1) Cache hit.
  try {
    const hit = readCache(await redis.get(key));
    if (hit) return hit;
  } catch {
    /* Redis unavailable — compute live below. */
  }

  // 2) Per-instance single-flight (in-process coalescing).
  const existing = inflight.get(center);
  if (existing) return existing;

  const p = (async () => {
    // 3) Cross-instance single-flight: only the lock leader computes.
    const lockKey = `${key}:sf`;
    let leader = false;
    try {
      leader = (await redis.set(lockKey, "1", "PX", LOCK_MS, "NX")) === "OK";
    } catch {
      leader = true; // Redis lock unavailable — degrade to computing (today's behavior)
    }

    if (!leader) {
      // Someone else is computing. Wait briefly for their result; if it doesn't
      // land in time (slow or dead leader), fail open rather than piling another
      // full fan-out onto the vendors — DEFAULT_RESULT is the route's existing
      // no-false-lock fallback, and the client keeps its last-known tiles.
      const waited = await waitForLeaderResult(key);
      return waited ?? DEFAULT_RESULT;
    }

    try {
      const result = await computeExperienceAvailability(center);
      try {
        await redis.set(key, JSON.stringify(result), "EX", TTL_SECONDS);
      } catch {
        /* Redis unavailable — serve uncached. */
      }
      return result;
    } finally {
      try {
        await redis.del(lockKey);
      } catch {
        /* lock self-expires after LOCK_MS */
      }
    }
  })().finally(() => inflight.delete(center));
  inflight.set(center, p);
  return p;
}

export async function GET(req: NextRequest) {
  const center = req.nextUrl.searchParams.get("center");
  if (!center || !VALID_CENTERS.includes(center as CenterCode)) {
    return NextResponse.json({ error: "valid center required" }, { status: 400 });
  }
  const { available, firstOpen } = await loadAvailability(center as CenterCode).catch(
    // Never false-lock: any failure reports everything available, no counts.
    () => DEFAULT_RESULT,
  );
  return NextResponse.json({ center, items: available, firstOpen });
}
