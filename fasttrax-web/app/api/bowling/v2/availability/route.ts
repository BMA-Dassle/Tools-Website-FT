import { NextRequest, NextResponse } from "next/server";
import { searchAvailability } from "@/lib/qamf-bowling";

/**
 * GET /api/bowling/v2/availability
 *
 * Wraps QAMF searchAvailability for both KBF and open bowling.
 *
 * QAMF constraint: StartAt and EndAt must be equal (point-in-time search,
 * not a range). QAMF returns all availability for the calendar day of
 * that datetime. We always use midnight UTC for the chosen date.
 *
 * Query params:
 *   centerId    — QAMF center ID (required)
 *   players     — number of players (required)
 *   startDate   — ISO date string 'YYYY-MM-DD' (required)
 *   service     — 'BookForLater' | 'PlayNow' (default: 'BookForLater')
 */
export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;

  const centerIdStr = searchParams.get("centerId");
  const playersStr = searchParams.get("players");
  const startDate = searchParams.get("startDate");
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

  // QAMF requires StartAt === EndAt (point-in-time).
  // Both centers are in Southwest Florida (Eastern time).
  // Use 8am Eastern so QAMF returns the full day's available slots.
  // May–Oct: EDT = -04:00; Nov–Mar: EST = -05:00.
  const month = parseInt(startDate.slice(5, 7), 10);
  const tzOffset = month >= 3 && month <= 11 ? "-04:00" : "-05:00";
  const bookedAt = `${startDate}T08:00:00${tzOffset}`;

  try {
    const result = await searchAvailability(centerId, {
      BookedAtRange: { StartAt: bookedAt, EndAt: bookedAt },
      TotalPlayers: players,
      WebOffer: { Services: [service] },
    });
    return NextResponse.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
