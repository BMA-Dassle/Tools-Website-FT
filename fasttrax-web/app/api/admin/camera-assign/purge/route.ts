import { NextRequest, NextResponse } from "next/server";
import redis from "@/lib/redis";

/**
 * POST /api/admin/camera-assign/purge
 *
 * Wipes all Redis keys from the camera-assign + video-match flows so
 * a rename/schema change starts fresh. Gated by ADMIN_CAMERA_TOKEN.
 *
 * Run once after the cameraNumber → systemNumber rename lands: old
 * records still have the old field name and would render with empty
 * 'System' fields until they TTL out on their own.
 *
 * Body:
 *   { dryRun?: boolean }  — if true, returns key counts without deleting.
 *
 * Clears:
 *   camera-assign:*        — assignment records + per-session indexes
 *   camera-watch:*         — OLD reverse lookup (renamed to system-watch)
 *   camera-history:*       — OLD time-indexed assignments (renamed)
 *   system-watch:*         — new reverse lookup (so partial mid-migration
 *                             state doesn't linger)
 *   system-history:*       — new time-indexed assignments
 *   video-match:*          — match records + by-code sentinels + log
 *   vt3:last-seen-id       — so the match cron re-scans from the top
 *   vt3:jwt                — force a fresh login
 *
 * Uses redis.scan (not KEYS) to avoid blocking the server on large sets.
 */

const PREFIXES = [
  "camera-assign:",
  "camera-watch:",
  "camera-history:",
  "system-watch:",
  "system-history:",
  "video-match:",
];

const SINGLE_KEYS = ["vt3:last-seen-id", "vt3:jwt"];

async function scanAndCollect(pattern: string, cap = 20000): Promise<string[]> {
  const keys: string[] = [];
  let cursor = "0";
  do {
    const [next, batch] = await redis.scan(cursor, "MATCH", pattern, "COUNT", 500);
    cursor = next;
    for (const k of batch) {
      keys.push(k);
      if (keys.length >= cap) return keys;
    }
  } while (cursor !== "0");
  return keys;
}

export async function POST(req: NextRequest) {
  let body: { dryRun?: boolean } = {};
  try { body = await req.json(); } catch { /* empty body is fine */ }

  const byPrefix: Record<string, number> = {};
  const allKeys: string[] = [];

  for (const p of PREFIXES) {
    const keys = await scanAndCollect(`${p}*`);
    byPrefix[p] = keys.length;
    allKeys.push(...keys);
  }
  byPrefix["(single keys)"] = SINGLE_KEYS.length;
  allKeys.push(...SINGLE_KEYS);

  if (body.dryRun) {
    return NextResponse.json({ ok: true, dryRun: true, byPrefix, total: allKeys.length });
  }

  // Delete in batches to avoid "ERR too many arguments" on large purges.
  let deleted = 0;
  const BATCH = 200;
  for (let i = 0; i < allKeys.length; i += BATCH) {
    const chunk = allKeys.slice(i, i + BATCH);
    if (chunk.length === 0) continue;
    // ioredis's variadic del requires at least one argument.
    const n = await redis.del(...chunk);
    deleted += typeof n === "number" ? n : 0;
  }

  return NextResponse.json({ ok: true, byPrefix, deleted });
}
