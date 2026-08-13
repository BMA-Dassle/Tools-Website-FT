import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { businessDayYmdET } from "@/lib/race-business-day";
import { listBriefingEvents } from "~/features/signage/briefing/events-db";
import { foldBriefingLog } from "~/features/signage/briefing/briefing-log";
import { listRaceTimings, listRaceTimingsSince } from "~/features/racing/data/race-timings-db";
import { summariseWaits, summariseWaitsByTrack, waitsForDay } from "~/features/racing/wait-times";

/**
 * WAIT TIMES — every movement, per group and averaged (owner 2026-08-12).
 *
 * Joins the two halves of the night: the briefing log (checked in → called →
 * sent → film → out of the room) and the venue's own race clock (flag to flag).
 * All of the rules live in ~/features/racing/wait-times.ts, which is pure and
 * tested; this route is the thin shell the house convention asks for — parse,
 * authorise, read, delegate.
 *
 *   GET /api/admin/wait-times?token=…                     today
 *   GET /api/admin/wait-times?token=…&day=2026-08-12
 *   GET /api/admin/wait-times?token=…&days=7              a rolling window
 *   GET /api/admin/wait-times?token=…&days=7&excludeToday=1   the week BEFORE today
 *
 * `excludeToday` is what makes a comparison mean anything. A board showing "today
 * vs the last seven days" against a window that CONTAINS today is comparing a
 * number with itself — and on the first day of data it is comparing it with
 * exactly itself, so every tile reads "about the same" forever. The baseline has
 * to be the days BEFORE today, and that is a decision this route makes rather
 * than leaving each caller to do date arithmetic against a 2 AM rollover.
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

/** `n` business days before `from`. Anchored at noon UTC so stepping back never
 *  trips a DST boundary — the same discipline race-business-day itself uses. */
function businessDayMinus(from: string, n: number): string {
  const d = new Date(`${from}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

export async function GET(req: NextRequest) {
  if (!authed(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const params = req.nextUrl.searchParams;
  const dayParam = params.get("day");
  const daysParam = Number(params.get("days"));
  const days =
    Number.isFinite(daysParam) && daysParam > 1 ? Math.min(MAX_DAYS, Math.floor(daysParam)) : 1;

  // The window's LAST day: today, or yesterday when today is being excluded so
  // the caller can compare today against the days before it.
  const excludeToday = params.get("excludeToday") === "1";
  const today = businessDayYmdET();
  const toDay = excludeToday ? businessDayMinus(today, 1) : today;

  // A single day (today, or a named one) reads that day's events; a window reads
  // the range. Either way the fold and the summary are the same pure functions.
  const singleDay = days === 1 && !excludeToday ? (dayParam ?? today) : null;
  const fromDay = singleDay ?? businessDayMinus(toDay, days - 1);
  const nowMs = Date.now();

  try {
    const [events, races] = await Promise.all([
      singleDay
        ? listBriefingEvents(VENUE, singleDay)
        : listBriefingEventsRange(VENUE, fromDay, days),
      singleDay ? listRaceTimings(VENUE, singleDay) : listRaceTimingsSince(VENUE, fromDay, toDay),
    ]);

    const briefings = foldBriefingLog(events, nowMs);
    const waits = waitsForDay(briefings, races);
    const summary = summariseWaits(waits);

    return NextResponse.json(
      {
        venue: VENUE,
        from: fromDay,
        to: singleDay ?? toDay,
        days,
        // What the averages were computed FROM, so a thin night is visible as a
        // thin night rather than read as a confident number.
        sessions: waits.length,
        racesRecorded: races.length,
        summary,
        // Split by track as well as combined: blue and red run their own
        // schedules with their own delays, so one merged average describes a
        // night neither track actually had.
        byTrack: summariseWaitsByTrack(waits),
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
