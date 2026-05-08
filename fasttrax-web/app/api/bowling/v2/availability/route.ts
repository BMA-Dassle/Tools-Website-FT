import { NextRequest, NextResponse } from "next/server";
import { searchAvailability } from "@/lib/qamf-bowling";

/**
 * GET /api/bowling/v2/availability
 *
 * Returns all available slots for a given date by probing every 30 minutes
 * in parallel. QAMF's searchAvailability is a point-in-time check — it
 * returns exactly one slot if available at the probed time, nothing otherwise.
 * A range query is not supported (StartAt must equal EndAt).
 *
 * Both HeadPinz centers are in Eastern time (EDT -04:00 May–Nov, EST -05:00 otherwise).
 * Probes 9:00 am → 11:30 pm in 30-min increments (29 probes, all in parallel).
 *
 * Query params:
 *   centerId    — QAMF center ID (required)
 *   players     — number of players (required)
 *   startDate   — ISO date string 'YYYY-MM-DD' (required)
 *   webOfferId  — filter to a specific QAMF web offer ID (optional but recommended)
 */

// Probe times: 9:00 am to 11:30 pm in 30-min increments
const PROBE_HOURS_START = 9;   // 9am
const PROBE_HOURS_END   = 23;  // last probe at 11:30pm (23:30)

function buildProbeTimes(date: string, tzOffset: string): string[] {
  const times: string[] = [];
  for (let h = PROBE_HOURS_START; h <= PROBE_HOURS_END; h++) {
    for (const m of [0, 30]) {
      if (h === PROBE_HOURS_END && m === 30) break; // stop at 23:30
      times.push(
        `${date}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00${tzOffset}`,
      );
    }
  }
  return times;
}

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;

  const centerIdStr   = searchParams.get("centerId");
  const playersStr    = searchParams.get("players");
  const startDate     = searchParams.get("startDate");
  const webOfferIdStr = searchParams.get("webOfferId");

  if (!centerIdStr || !playersStr || !startDate) {
    return NextResponse.json(
      { error: "centerId, players, and startDate are required" },
      { status: 400 },
    );
  }

  const centerId   = parseInt(centerIdStr, 10);
  const players    = parseInt(playersStr, 10);
  const webOfferId = webOfferIdStr ? parseInt(webOfferIdStr, 10) : undefined;

  if (isNaN(centerId) || isNaN(players) || players < 1) {
    return NextResponse.json({ error: "invalid centerId or players" }, { status: 400 });
  }

  // Both centers are in Southwest Florida (Eastern time).
  const month = parseInt(startDate.slice(5, 7), 10);
  const tzOffset = month >= 3 && month <= 11 ? "-04:00" : "-05:00";

  const probeTimes = buildProbeTimes(startDate, tzOffset);

  const webOfferFilter: { Id?: number; Services: "BookForLater"[] } = {
    Services: ["BookForLater"],
    ...(webOfferId ? { Id: webOfferId } : {}),
  };

  // Fire all probes in parallel
  try {
    const results = await Promise.all(
      probeTimes.map((bookedAt) =>
        searchAvailability(centerId, {
          BookedAtRange: { StartAt: bookedAt, EndAt: bookedAt },
          TotalPlayers: players,
          WebOffer: webOfferFilter,
        }).catch(() => ({ Availabilities: [] })), // swallow individual failures
      ),
    );

    // Flatten, deduplicate by BookedAt, sort chronologically
    const seen = new Set<string>();
    const availabilities = results
      .flatMap((r) => r.Availabilities)
      .filter((a) => {
        if (seen.has(a.BookedAt)) return false;
        seen.add(a.BookedAt);
        return true;
      })
      .sort((a, b) => a.BookedAt.localeCompare(b.BookedAt));

    return NextResponse.json({ Availabilities: availabilities });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
