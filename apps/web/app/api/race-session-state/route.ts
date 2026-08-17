import { NextRequest, NextResponse } from "next/server";
import redis from "@/lib/redis";
import { bmiKeyScope } from "@/lib/bmi-key-scope";

/**
 * Per-session "was this heat called for check-in?" flag.
 *
 *   GET /api/race-session-state?sessionId=44592374[&locationId=PPTR5G2N0QXF7]
 *   → { sessionId, wasCalled: true|false }
 *
 * The checkin-alerts crons write `race:called:{scope}{sessionId}` with 12h
 * TTL when Pandora first reports the session as called. The ticket page
 * uses this to flip to MissedCard once Pandora drops the session from the
 * currently-checking-in list (~20 min after call).
 *
 * locationId is optional: absent/FM values map to the legacy key shape
 * (racing + HP FM share one BMI server); separate-server locations
 * (HP Naples) get a scoped key — see lib/bmi-key-scope.ts.
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const sessionId = url.searchParams.get("sessionId");
  const locationId = url.searchParams.get("locationId") || "";
  if (!sessionId || !/^\d+$/.test(sessionId)) {
    return NextResponse.json({ error: "Invalid sessionId" }, { status: 400 });
  }
  if (locationId && !/^[A-Z0-9]{1,32}$/.test(locationId)) {
    return NextResponse.json({ error: "Invalid locationId" }, { status: 400 });
  }
  const scope = bmiKeyScope(locationId);
  try {
    // Either signal counts: race:called (written on first called sight)
    // OR the session-level alert dedup key (written when an alert fired).
    // Both mean the session entered the checking-in window at some point.
    // Racing + arena write different alert key families, so check both —
    // a hit on either is the same "was called" answer.
    const [called, alerted, arenaAlerted] = await Promise.all([
      redis.get(`race:called:${scope}${sessionId}`),
      redis.get(`alert:checkin:session:${scope}${sessionId}`),
      redis.get(`alert:arena-checkin:session:${scope}${sessionId}`),
    ]);
    return NextResponse.json(
      { sessionId, wasCalled: !!called || !!alerted || !!arenaAlerted },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return NextResponse.json(
      { sessionId, wasCalled: false, error: "redis-unavailable" },
      { headers: { "Cache-Control": "no-store" } },
    );
  }
}
