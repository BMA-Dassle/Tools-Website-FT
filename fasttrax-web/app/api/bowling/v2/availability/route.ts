import { NextRequest, NextResponse } from "next/server";
import { searchAvailability } from "@/lib/qamf-bowling";

/**
 * GET /api/bowling/v2/availability
 *
 * Wraps QAMF searchAvailability for both KBF and open bowling.
 *
 * Query params:
 *   centerId    — QAMF center ID (required)
 *   players     — number of players (required)
 *   startDate   — ISO date string 'YYYY-MM-DD' (required)
 *   endDate     — ISO date string 'YYYY-MM-DD' (defaults to startDate)
 *   service     — 'BookForLater' | 'PlayNow' (default: 'BookForLater')
 */
export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;

  const centerIdStr = searchParams.get("centerId");
  const playersStr = searchParams.get("players");
  const startDate = searchParams.get("startDate");
  const endDate = searchParams.get("endDate") ?? startDate;
  const service = (searchParams.get("service") ?? "BookForLater") as
    | "BookForLater"
    | "PlayNow";

  if (!centerIdStr || !playersStr || !startDate) {
    return NextResponse.json(
      { error: "centerId, players, and startDate are required" },
      { status: 400 },
    );
  }

  const centerId = parseInt(centerIdStr, 10);
  const players = parseInt(playersStr, 10);
  if (isNaN(centerId) || isNaN(players) || players < 1) {
    return NextResponse.json({ error: "invalid centerId or players" }, { status: 400 });
  }

  // Build ISO date-time range covering the full day(s) at the start of UTC
  const startAt = `${startDate}T00:00:00+00:00`;
  const endAt = `${endDate}T23:59:59+00:00`;

  try {
    const result = await searchAvailability(centerId, {
      BookedAtRange: { StartAt: startAt, EndAt: endAt },
      TotalPlayers: players,
      WebOffer: { Services: [service] },
    });
    return NextResponse.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
