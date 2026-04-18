import { NextRequest, NextResponse } from "next/server";
import redis from "@/lib/redis";

/**
 * Per-session "was this heat called for check-in?" flag.
 *
 *   GET /api/race-session-state?sessionId=44592374
 *   → { sessionId, wasCalled: true|false }
 *
 * The checkin-alerts cron writes `race:called:{sessionId}` with 12h TTL when
 * Pandora first reports the session in /races-current. The ticket page uses
 * this to flip to MissedCard once Pandora drops the session from the
 * currently-checking-in list (~20 min after call).
 */
export async function GET(req: NextRequest) {
  const sessionId = new URL(req.url).searchParams.get("sessionId");
  if (!sessionId || !/^\d+$/.test(sessionId)) {
    return NextResponse.json({ error: "Invalid sessionId" }, { status: 400 });
  }
  try {
    const v = await redis.get(`race:called:${sessionId}`);
    return NextResponse.json(
      { sessionId, wasCalled: !!v },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return NextResponse.json(
      { sessionId, wasCalled: false, error: "redis-unavailable" },
      { headers: { "Cache-Control": "no-store" } },
    );
  }
}
