import { NextRequest, NextResponse } from "next/server";
import redis from "@/lib/redis";
import {
  computeExperienceAvailability,
  type ExperienceAvailability,
} from "~/features/kiosk/service/experience-availability";
import type { CenterCode } from "~/features/booking";

/**
 * Cached kiosk Experience availability. Kiosks poll this cheap endpoint; the
 * expensive BMI/QAMF feasibility runs SERVER-side and is cached in Redis so the
 * vendors are hit at most once per TTL per center — not once per kiosk poll.
 *
 * GET /api/kiosk/availability?center=fort-myers
 *   → { center, items: { "race-bowl": bool, "ultimate-qualifier": bool } }
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VALID_CENTERS: CenterCode[] = ["fort-myers", "naples"];
const TTL_SECONDS = 300; // recompute at most once per 5 min per center
const cacheKey = (c: string) => `kiosk:avail:${c}`;

const DEFAULT_AVAILABLE: ExperienceAvailability = {
  "race-bowl": true,
  "ultimate-qualifier": true,
};

// Per-instance single-flight so concurrent cache misses don't stampede vendors.
const inflight = new Map<string, Promise<ExperienceAvailability>>();

async function loadAvailability(center: CenterCode): Promise<ExperienceAvailability> {
  const key = cacheKey(center);

  // 1) Cache hit.
  try {
    const cached = await redis.get(key);
    if (cached) return JSON.parse(cached) as ExperienceAvailability;
  } catch {
    /* Redis unavailable — compute live below. */
  }

  // 2) Single-flight compute + cache.
  const existing = inflight.get(center);
  if (existing) return existing;
  const p = (async () => {
    const items = await computeExperienceAvailability(center);
    try {
      await redis.set(key, JSON.stringify(items), "EX", TTL_SECONDS);
    } catch {
      /* Redis unavailable — serve uncached. */
    }
    return items;
  })().finally(() => inflight.delete(center));
  inflight.set(center, p);
  return p;
}

export async function GET(req: NextRequest) {
  const center = req.nextUrl.searchParams.get("center");
  if (!center || !VALID_CENTERS.includes(center as CenterCode)) {
    return NextResponse.json({ error: "valid center required" }, { status: 400 });
  }
  try {
    const items = await loadAvailability(center as CenterCode);
    return NextResponse.json({ center, items });
  } catch {
    // Never false-lock: any failure reports everything available.
    return NextResponse.json({ center, items: DEFAULT_AVAILABLE });
  }
}
