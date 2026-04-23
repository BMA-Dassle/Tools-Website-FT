import { NextRequest, NextResponse } from "next/server";
import redis from "@/lib/redis";

/**
 * POST /api/admin/camera-assign/rewind-cron
 *
 * Rewinds the video-match cron's high-water mark (vt3:last-seen-id) and
 * clears any match-sentinel entries so the next cron fire re-processes
 * today's backlog against the current match logic.
 *
 * Body:
 *   { confirm: true }   required — guard against accidental hits
 *   clearMatches?: bool optional — also drop existing video-match:* records
 *                        so matches can be fully recomputed (rarely wanted;
 *                        wipes notify-already-fired memory)
 *
 * Use after changing how the cron matches (e.g. the system→camera swap)
 * so the cron can re-try unmatched videos whose cursor it already
 * advanced past. Does NOT touch camera-assign / system-watch / system-
 * history — those are the staff's scans and must be preserved.
 *
 * Auth: middleware gates /api/admin/camera-assign/* on ADMIN_CAMERA_TOKEN.
 */

export async function POST(req: NextRequest) {
  let body: { confirm?: boolean; clearMatches?: boolean } = {};
  try { body = await req.json(); } catch { /* empty body is fine for the 400 below */ }
  if (!body.confirm) {
    return NextResponse.json(
      { error: "Refusing without { confirm: true } in the body." },
      { status: 400 },
    );
  }

  const deleted: Record<string, number> = {};

  // 1. Drop the cron cursor. Next fire walks the newest-N videos and
  //    attempts to match any that aren't already sentineled.
  const hadCursor = await redis.del("vt3:last-seen-id");
  deleted["vt3:last-seen-id"] = hadCursor;

  // 2. Optionally drop the match-already-seen sentinels so the cron
  //    can actually re-evaluate each video. (If left in place, the
  //    cron still skips videos that previously got a match record.)
  if (body.clearMatches) {
    const scan = async (pattern: string) => {
      const keys: string[] = [];
      let cursor = "0";
      do {
        const [next, batch] = await redis.scan(cursor, "MATCH", pattern, "COUNT", 500);
        cursor = next;
        keys.push(...batch);
      } while (cursor !== "0");
      return keys;
    };
    const sentinelKeys = await scan("video-match:by-code:*");
    const matchKeys = await scan("video-match:*");
    const logKey = ["video-match:log"];
    const all = [...sentinelKeys, ...matchKeys, ...logKey];
    let deletedCount = 0;
    const BATCH = 200;
    for (let i = 0; i < all.length; i += BATCH) {
      const chunk = all.slice(i, i + BATCH);
      if (chunk.length === 0) continue;
      deletedCount += (await redis.del(...chunk)) || 0;
    }
    deleted["video-match:*"] = deletedCount;
  }

  return NextResponse.json({ ok: true, deleted });
}
