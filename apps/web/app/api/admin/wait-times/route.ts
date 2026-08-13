import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { businessDayYmdET } from "@/lib/race-business-day";
import { listBriefingEvents } from "~/features/signage/briefing/events-db";
import { foldBriefingLog } from "~/features/signage/briefing/briefing-log";
import { listRaceTimings, listRaceTimingsSince } from "~/features/racing/data/race-timings-db";
import { summariseWaits, waitsForDay } from "~/features/racing/wait-times";

/**
 * WAIT TIMES — every movement, per group and averaged (owner 2026-08-12).
 *
 * Joins the two halves of the night: the briefing log (checked in → called →
 * sent → film → out of the room) and the venue's own race clock (flag to flag).
 * All of the rules live in ~/features/racing/wait-times.ts, which is pure and
 * tested; this route is the thin shell the house convention asks for — parse,
 * authorise, read, delegate.
 *
 *   GET /api/admin/wait-times?token=…              today
 *   GET /api/admin/wait-times?token=…&day=2026-08-12
 *   GET /api/admin/wait-times?token=…&days=7       a rolling window, one summary
 *
 * DAYS ARE BUSINESS DAYS, ET with the 2 AM rollover — the same day a race night
 * belongs to everywhere else in this codebase. A Friday heat that ran at 1 AM is
 * Friday's, and anything else would split a single night's averages in two.
 *
 * READ-ONLY, and admin-token gated like the rest of /api/admin/*. Nothing
 * person-level is in either table, so the payload is heats and durations — but a
 * business's own operating times are not public, hence the gate.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VENUE = "FT";
/** A month is plenty for a trend and bounded enough to stay one quick query. */
const MAX_DAYS = 31;

function authed(req: NextRequest): boolean {
  const expected = process.env.ADMIN_CAMERA_TOKEN || "";
  if (!expected) return false;
  const token = req.nextUrl.searchParams.get("token") || req.headers.get("x-admin-token") || "";
  return token === expected;
}

/** `days` back from today, as a business-day string. */
function businessDayBack(days: number): string {
  const today = businessDayYmdET();
  // Anchored at noon UTC so stepping back a day never trips a DST boundary —
  // the same discipline race-business-day itself uses.
  const d = new Date(`${today}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - (days - 1));
  return d.toISOString().slice(0, 10);
}

export async function GET(req: NextRequest) {
  if (!authed(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const params = req.nextUrl.searchParams;
  const dayParam = params.get("day");
  const daysParam = Number(params.get("days"));
  const days =
    Number.isFinite(daysParam) && daysParam > 1 ? Math.min(MAX_DAYS, Math.floor(daysParam)) : 1;

  // A single day (today, or a named one) reads that day's events; a window reads
  // the range. Either way the fold and the summary are the same pure functions.
  const singleDay = days === 1 ? (dayParam ?? businessDayYmdET()) : null;
  const fromDay = singleDay ?? businessDayBack(days);
  const nowMs = Date.now();

  try {
    const [events, races] = await Promise.all([
      singleDay
        ? listBriefingEvents(VENUE, singleDay)
        : listBriefingEventsRange(VENUE, fromDay, days),
      singleDay ? listRaceTimings(VENUE, singleDay) : listRaceTimingsSince(VENUE, fromDay),
    ]);

    const briefings = foldBriefingLog(events, nowMs);
    const waits = waitsForDay(briefings, races);
    const summary = summariseWaits(waits);

    return NextResponse.json(
      {
        venue: VENUE,
        from: fromDay,
        to: singleDay ?? businessDayYmdET(),
        days,
        // What the averages were computed FROM, so a thin night is visible as a
        // thin night rather than read as a confident number.
        sessions: waits.length,
        racesRecorded: races.length,
        summary,
        waits,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "wait times unavailable" },
      { status: 500 },
    );
  }
}

/**
 * A window's briefing events.
 *
 * The events table is keyed by business day (that is the index), so a range is a
 * handful of day reads rather than a scan — bounded by MAX_DAYS above, and run
 * together so the window costs one round trip's latency, not thirty.
 */
async function listBriefingEventsRange(venue: string, fromDay: string, days: number) {
  const start = new Date(`${fromDay}T12:00:00Z`);
  const dayKeys: string[] = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(start);
    d.setUTCDate(d.getUTCDate() + i);
    dayKeys.push(d.toISOString().slice(0, 10));
  }
  const perDay = await Promise.all(dayKeys.map((day) => listBriefingEvents(venue, day)));
  return perDay.flat();
}
