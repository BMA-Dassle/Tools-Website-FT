import { NextRequest, NextResponse } from "next/server";
import { searchAvailability } from "@/lib/qamf-bowling";
import redis from "@/lib/redis";

/**
 * GET /api/bowling/v2/availability
 *
 * Returns all available slots for a given date by probing every 30 minutes
 * in parallel. QAMF's searchAvailability is a point-in-time check — it
 * returns exactly one slot if available at the probed time, nothing otherwise.
 * A range query is not supported (StartAt must equal EndAt).
 *
 * Both HeadPinz centers are in Eastern time (EDT -04:00 May–Nov, EST -05:00 otherwise).
 * Probes 9:00 am → 11:45 pm in 15-min increments (60 probes, all in parallel).
 *
 * Results are cached in Redis for 5 minutes per (centerId, date, webOfferId, players)
 * to avoid hammering QAMF on every page view.
 *
 * Query params:
 *   centerId    — QAMF center ID (required)
 *   players     — number of players (required)
 *   startDate   — ISO date string 'YYYY-MM-DD' (required)
 *   webOfferId  — filter to a specific QAMF web offer ID (optional but recommended)
 */

const CACHE_TTL_SECONDS = 300; // 5 minutes

// Probe times: 9:00 am to 1:45 am (next calendar day) in 15-min increments.
// Hours 0–1 on the NEXT day are represented as the following calendar date
// because ISO timestamps cross midnight (e.g. booking on May 9 at 1:00 AM ET
// is "2026-05-10T01:00:00-04:00").
const PROBE_HOURS_START = 9;  // 9 am same day
const PROBE_HOURS_END   = 25; // 1:45 am next calendar day (25 = 24+1)

function buildProbeTimes(date: string, tzOffset: string): string[] {
  const times: string[] = [];

  // Parse the booking date so we can roll it forward for post-midnight hours
  const [y, mo, d] = date.split("-").map(Number);
  const nextDate = new Date(y, mo - 1, d + 1);
  const nextDateStr = `${nextDate.getFullYear()}-${String(nextDate.getMonth() + 1).padStart(2, "0")}-${String(nextDate.getDate()).padStart(2, "0")}`;

  for (let h = PROBE_HOURS_START; h <= PROBE_HOURS_END; h++) {
    for (const m of [0, 15, 30, 45]) {
      if (h === PROBE_HOURS_END && m === 45) break; // stop at 1:45 am
      const calHour = h % 24; // 24 → 0, 25 → 1
      const calDate = h >= 24 ? nextDateStr : date;
      times.push(
        `${calDate}T${String(calHour).padStart(2, "0")}:${String(m).padStart(2, "0")}:00${tzOffset}`,
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

  // Check Redis cache first
  const cacheKey = `bowling:avail:${centerId}:${startDate}:${webOfferId ?? "all"}:${players}`;
  try {
    const cached = await redis.get(cacheKey);
    if (cached) {
      return NextResponse.json(JSON.parse(cached) as object, {
        headers: { "X-Cache": "HIT" },
      });
    }
  } catch {
    // Redis unavailable — fall through to QAMF
  }

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

    // Flatten, deduplicate by (BookedAt + WebOffer.Id), sort chronologically.
    // QAMF returns ALL enabled offers in every probe response regardless of the
    // WebOffer.Id filter — so two offers at the same BookedAt arrive in the same
    // results array. Keying on BookedAt alone would drop every offer after the first.
    const seen = new Set<string>();
    const availabilities = results
      .flatMap((r) => r.Availabilities)
      .filter((a) => {
        const key = `${a.BookedAt}::${a.WebOffer.Id}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort((a, b) => a.BookedAt.localeCompare(b.BookedAt));

    const payload = { Availabilities: availabilities };

    // Cache in Redis (fire-and-forget — don't block response)
    redis.set(cacheKey, JSON.stringify(payload), "EX", CACHE_TTL_SECONDS).catch(() => {});

    return NextResponse.json(payload, { headers: { "X-Cache": "MISS" } });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
