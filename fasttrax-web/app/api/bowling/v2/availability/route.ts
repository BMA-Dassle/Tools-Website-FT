import { NextRequest, NextResponse } from "next/server";
import { searchAvailability } from "@/lib/qamf-bowling";
import redis from "@/lib/redis";
import { HP_LOCATIONS } from "@/lib/headpinz-locations";

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
 * Post-fetch filter: slots whose start time + duration would exceed the
 * center's closing time are removed. Duration comes from the slot's own
 * WebOffer.Options.Time[].Minutes or from the `durationMinutes` query param.
 *
 * Query params:
 *   centerId        — QAMF center ID (required)
 *   players         — number of players (required)
 *   startDate       — ISO date string 'YYYY-MM-DD' (required)
 *   webOfferId      — filter to a specific QAMF web offer ID (optional but recommended)
 *   durationMinutes — booking duration in minutes; overrides WebOffer option (optional)
 */

const CACHE_TTL_SECONDS = 300; // 5 minutes

// Probe times: 9:00 am to 1:45 am (next calendar day) in 15-min increments.
// Hours 0–1 on the NEXT day are represented as the following calendar date
// because ISO timestamps cross midnight (e.g. booking on May 9 at 1:00 AM ET
// is "2026-05-10T01:00:00-04:00").
const PROBE_HOURS_START = 9;  // 9 am same day
const PROBE_HOURS_END   = 25; // 1:45 am next calendar day (25 = 24+1)

// QAMF center ID → HP_LOCATIONS slug (for closing-time lookup)
const QAMF_TO_HP_SLUG: Record<number, string> = {
  9172: "fort-myers",
  3148: "naples",
};

/**
 * Parse "11AM" → 11, "12AM" → 24, "2AM" → 26, "9PM" → 21.
 * Post-midnight hours (12 AM, 1 AM, 2 AM) are 24+ so they sort after 11 PM.
 */
function parseHourToken(token: string): number {
  const m = token.trim().match(/^(\d+)(AM|PM)$/i);
  if (!m) return 11;
  let h = parseInt(m[1], 10);
  const period = m[2].toUpperCase();
  if (period === "PM" && h !== 12) h += 12;
  if (period === "AM" && h <= 2) h += 24;       // 12 AM → 24, 1 AM → 25, 2 AM → 26
  if (period === "AM" && h === 12) h = 24;       // 12 AM → 24 (midnight)
  return h;
}

/**
 * Return closing hour (in 24+ notation) for the given QAMF center on a
 * specific date. Sun-Thu → hours, Fri-Sat → hoursWeekend.
 * Returns 26 (2 AM) as a safe fallback if the center isn't found.
 */
function closingHourForDate(centerId: number, dateStr: string): number {
  const slug = QAMF_TO_HP_SLUG[centerId];
  const loc = slug ? HP_LOCATIONS[slug] : undefined;
  if (!loc) return 26;
  const dow = new Date(`${dateStr}T12:00:00`).getDay(); // 0=Sun, 6=Sat
  const isWeekend = dow === 5 || dow === 6;
  const hoursStr = isWeekend ? loc.hoursWeekend : loc.hours;
  const timePart = hoursStr.split(" ").pop() ?? "11AM-2AM";
  const dash = timePart.lastIndexOf("-");
  const closeToken = timePart.slice(dash + 1);
  return parseHourToken(closeToken);
}

/**
 * Check whether a slot's start time + duration would exceed the center's
 * closing time. `bookedAt` is an ISO string with ET offset.
 * `durationMin` is the booking duration in minutes.
 * `closeHour24` is the closing hour in 24+ notation (24=midnight, 26=2AM).
 */
function slotExceedsClose(bookedAt: string, durationMin: number, closeHour24: number): boolean {
  const d = new Date(bookedAt);
  const endMs = d.getTime() + durationMin * 60_000;
  const end = new Date(endMs);
  // Convert end time to 24+ hours in ET
  const endET = new Date(end.toLocaleString("en-US", { timeZone: "America/New_York" }));
  let endHour24 = endET.getHours() + endET.getMinutes() / 60;
  // Post-midnight hours (0–2) should be 24+
  if (endHour24 < 6) endHour24 += 24;
  return endHour24 > closeHour24;
}

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

  const centerIdStr      = searchParams.get("centerId");
  const playersStr       = searchParams.get("players");
  const startDate        = searchParams.get("startDate");
  const webOfferIdStr    = searchParams.get("webOfferId");
  const durationMinStr   = searchParams.get("durationMinutes");

  if (!centerIdStr || !playersStr || !startDate) {
    return NextResponse.json(
      { error: "centerId, players, and startDate are required" },
      { status: 400 },
    );
  }

  const centerId        = parseInt(centerIdStr, 10);
  const players         = parseInt(playersStr, 10);
  const webOfferId      = webOfferIdStr ? parseInt(webOfferIdStr, 10) : undefined;
  const durationMinOver = durationMinStr ? parseInt(durationMinStr, 10) : undefined;

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
  const cacheKey = `bowling:avail:${centerId}:${startDate}:${webOfferId ?? "all"}:${players}:${durationMinOver ?? "auto"}`;
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
    let availabilities = results
      .flatMap((r) => r.Availabilities)
      .filter((a) => {
        const key = `${a.BookedAt}::${a.WebOffer.Id}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort((a, b) => a.BookedAt.localeCompare(b.BookedAt));

    // ── Filter slots that would run past closing time ──────────────
    // Duration comes from the query param or the slot's own Time option.
    const closeHour = closingHourForDate(centerId, startDate);
    availabilities = availabilities.filter((a) => {
      const mins = durationMinOver
        ?? a.WebOffer?.Options?.Time?.[0]?.Minutes
        ?? undefined;
      if (!mins || mins <= 0) return true; // no duration info → keep (game/unlimited)
      return !slotExceedsClose(a.BookedAt, mins, closeHour);
    });

    const payload = { Availabilities: availabilities };

    // Cache in Redis (fire-and-forget — don't block response)
    redis.set(cacheKey, JSON.stringify(payload), "EX", CACHE_TTL_SECONDS).catch(() => {});

    return NextResponse.json(payload, { headers: { "X-Cache": "MISS" } });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
