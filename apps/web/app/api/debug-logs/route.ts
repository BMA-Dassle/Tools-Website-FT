import { NextRequest, NextResponse } from "next/server";
import redis from "@/lib/redis";

/**
 * GET /api/admin/debug-logs?prefix=unified-reserve:log
 *
 * Reads recent debug log keys from Redis for troubleshooting.
 * Returns the latest 10 log entries matching the prefix.
 */
export async function GET(req: NextRequest) {
  const prefix = req.nextUrl.searchParams.get("prefix") ?? "unified-reserve:log";

  try {
    const keys = await redis.keys(`${prefix}:*`);
    const sorted = keys.sort().reverse().slice(0, 10);

    const results: Record<string, unknown> = {};
    for (const key of sorted) {
      const val = await redis.get(key);
      try {
        results[key] = val ? JSON.parse(val) : null;
      } catch {
        results[key] = val;
      }
    }

    return NextResponse.json({ keys: sorted, logs: results });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to read logs" },
      { status: 500 },
    );
  }
}
