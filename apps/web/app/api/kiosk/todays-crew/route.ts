import { NextRequest, NextResponse } from "next/server";
import { isCenterSlug } from "~/features/kiosk/checkin/centers";
import { rateLimited } from "~/features/kiosk/checkin/server";
import { readTodaysCrew } from "~/features/kiosk/todays-crew/service.server";
import type { TodaysCrewResponse } from "~/features/kiosk/todays-crew/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Kiosk GUEST "Today's Crew" API — who booked WITH this person earlier today
 * at this centre, READ-ONLY (owner 2026-09-06).
 *
 * No staff token ON PURPOSE, same posture as /api/kiosk/race-history and the
 * family read on /api/pandora?personId=…&allRelated=true: the personId is the
 * capability — ids are only obtained by signing in on the kiosk (OTP, licence
 * scan, member QR), and nothing here writes. What comes back is the same
 * class of information the family read already exposes (names, waiver state
 * of people on the same account); here it is people on the same BOOKING.
 * Per-IP rate limit on top, fail-open like the check-in buckets.
 *
 * Reads Neon only — never Pandora, never Office (see service.server.ts).
 */

const ID_RE = /^\d{1,20}$/;

function clientIp(req: NextRequest): string {
  const fwd = req.headers.get("x-forwarded-for") || "";
  return fwd.split(",")[0].trim() || req.headers.get("x-real-ip") || "unknown";
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const personId = searchParams.get("personId") || "";
  const center = searchParams.get("center") || "";
  if (!ID_RE.test(personId) || !isCenterSlug(center)) {
    return NextResponse.json({ error: "personId + center required" }, { status: 400 });
  }
  if (await rateLimited("todays-crew", clientIp(req), 30)) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }
  const crew = await readTodaysCrew(personId, center);
  return NextResponse.json<TodaysCrewResponse>(
    { crew },
    { headers: { "Cache-Control": "no-store" } },
  );
}
