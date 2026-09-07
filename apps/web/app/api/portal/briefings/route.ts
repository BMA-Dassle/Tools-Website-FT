import { NextRequest, NextResponse } from "next/server";
import { verifyPortal } from "@/lib/portal-auth";
import { businessDayYmdET } from "@/lib/race-business-day";
import { countBriefingsByStaff } from "~/features/signage/briefing/assignments-db";

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
 * Thin shell: validate, authorise, delegate — the grouping is one query in
 * ~/features/signage/briefing/assignments-db.
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
    const { staff, unattributed } = await countBriefingsByStaff(VENUE, businessDay);
    return NextResponse.json(
      { businessDay, venue: VENUE, staff, unattributed },
      // A live count on a TV. Anything cached is a board that stops moving.
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    console.error("[portal/briefings] Error:", err);
    return NextResponse.json({ error: "Internal error", code: "INTERNAL_ERROR" }, { status: 500 });
  }
}
