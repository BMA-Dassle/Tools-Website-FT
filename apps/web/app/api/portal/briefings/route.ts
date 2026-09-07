import { NextRequest, NextResponse } from "next/server";
import { verifyPortal } from "@/lib/portal-auth";
import { businessDayYmdET } from "@/lib/race-business-day";
import { countBriefingsByStaff } from "~/features/signage/briefing/assignments-db";
import { currentStaffRaces } from "~/features/staff/current-races";

/**
 * GET /api/portal/briefings?date=YYYY-MM-DD
 *
 * How many groups each pit staff member briefed on a day, keyed by their
 * 7shifts USER id.
 *
 * WHO CONSUMES IT: the HeadPinz portal's pit board TV
 * (portal.headpinz.com/tv/pit-board), which already builds its roster from
 * 7shifts user ids — so the count merges onto a person by id, with no name
 * matching between two systems that spell "Anthony L." differently. A person
 * with no row simply has no pill.
 *
 * WHY THE DATE IS A PARAMETER, and the caller's rather than ours: the racing
 * day here rolls at 2 AM ET (see lib/race-business-day) and the portal's rolls
 * at 5 AM. Between those two hours the two systems disagree about what "today"
 * is — so the portal passes the day IT is showing and gets the counts for that
 * day, instead of both sides guessing. No races run between 2 and 5 AM, so the
 * two answers only ever differ over an empty window. Omitting it asks for our
 * own business day, which is what an operator poking at the endpoint wants.
 *
 * ALSO CARRIES `active[]` — who is on a group RIGHT NOW, with the track and
 * heat, so the portal's board can print the race tag (B35 / R33 / M12) beside
 * the flag count on the same row. That half is not dated: there is no
 * historical form of "who is holding a group", so it always describes this
 * instant. See ~/features/staff/current-races.
 *
 * Thin shell: validate, authorise, delegate — the grouping is one query in
 * ~/features/signage/briefing/assignments-db, and the floor is a fold over
 * Redis in ~/features/staff/current-races-fold.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Only FastTrax records briefings, so the venue is a constant, not a param. */
const VENUE = "FT";

export async function GET(req: NextRequest) {
  const denied = await verifyPortal(req);
  if (denied) return denied;

  const date = req.nextUrl.searchParams.get("date");
  if (date != null && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return NextResponse.json(
      { error: "date must be YYYY-MM-DD", code: "INVALID_REQUEST" },
      { status: 400 },
    );
  }
  const businessDay = date ?? businessDayYmdET();

  try {
    const [{ staff, unattributed }, active] = await Promise.all([
      countBriefingsByStaff(VENUE, businessDay),
      /**
       * WHO IS RUNNING A GROUP RIGHT NOW — added in the same request rather
       * than a second endpoint, because the portal's board renders the two on
       * one row: the flag count and the race tag beside it. Two calls would be
       * two poll cadences and a row that can show a person's count from one
       * moment and their race from another.
       *
       * NOT DATED, unlike the counts. "Who is on a group" is a question about
       * this instant — there is no historical form of it — so it ignores the
       * `date` param entirely, and a caller asking about yesterday gets
       * yesterday's counts with today's (probably empty) floor.
       *
       * A failed read is an empty list, never a 500: the counts are this
       * endpoint's job, and a Redis blip must not take them down with it.
       */
      currentStaffRaces().catch(() => []),
    ]);
    return NextResponse.json(
      { businessDay, venue: VENUE, staff, unattributed, active },
      // A live count on a TV. Anything cached is a board that stops moving.
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    console.error("[portal/briefings] Error:", err);
    return NextResponse.json({ error: "Internal error", code: "INTERNAL_ERROR" }, { status: 500 });
  }
}
