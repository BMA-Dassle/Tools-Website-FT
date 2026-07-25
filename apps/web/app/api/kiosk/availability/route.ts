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
const TTL_SECONDS = 300; // recompute at most once per 5 min per center
// v2: cached value now carries firstOpen alongside the booleans — bumping the
// key sidesteps reading a pre-existing flat-boolean entry during rollout.
const cacheKey = (c: string) => `kiosk:avail:v2:${c}`;

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

// Per-instance single-flight so concurrent cache misses don't stampede vendors.
const inflight = new Map<string, Promise<ExperienceAvailabilityResult>>();

async function loadAvailability(center: CenterCode): Promise<ExperienceAvailabilityResult> {
  const key = cacheKey(center);

  // 1) Cache hit. Ignore anything missing the v2 `available` shape (defensive —
  //    the key bump should already prevent an old flat-boolean entry here).
  try {
    const cached = await redis.get(key);
    if (cached) {
      const parsed = JSON.parse(cached) as ExperienceAvailabilityResult;
      if (parsed?.available) return parsed;
    }
  } catch {
    /* Redis unavailable — compute live below. */
  }

  // 2) Single-flight compute + cache.
  const existing = inflight.get(center);
  if (existing) return existing;
  const p = (async () => {
    const result = await computeExperienceAvailability(center);
    try {
      await redis.set(key, JSON.stringify(result), "EX", TTL_SECONDS);
    } catch {
      /* Redis unavailable — serve uncached. */
    }
    return result;
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
