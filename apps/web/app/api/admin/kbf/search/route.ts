import { NextRequest, NextResponse } from "next/server";
import { searchPasses, loadPassesWithMembers } from "@/lib/kbf-prefs";
import { getKbfRedeemedMembers, getKbfFutureReservationsByPass } from "@/lib/bowling-db";

/**
 * POST /api/admin/kbf/search
 *
 * Broad search: name, partial email, or phone fragment.
 * "jacob" → finds jacob@headpinz.com
 * "239776" → finds by phone
 * "smith" → finds by last name
 *
 * Body: { query: string }
 */
export async function POST(req: NextRequest) {
  const { query } = await req.json();
  if (!query || typeof query !== "string") {
    return NextResponse.json({ error: "query required" }, { status: 400 });
  }

  const passes = await searchPasses(query);

  if (passes.length === 0) {
    return NextResponse.json({ passes: [], redeemedToday: [] });
  }

  const passIds = passes.map((p) => p.id);
  const full = await loadPassesWithMembers(passIds);

  // Check today's redemptions — date in ET
  const todayET = new Date().toLocaleDateString("en-CA", {
    timeZone: "America/New_York",
  });
  const allPairs = full.flatMap((p) => p.members.map((m) => ({ passId: p.id, slot: m.slot })));
  const redeemed = allPairs.length > 0 ? await getKbfRedeemedMembers(todayET, allPairs) : [];

  // Check for future KBF reservations — blocks Book Lane for passes that already have one
  const futureRez = await getKbfFutureReservationsByPass(passIds);

  return NextResponse.json({
    passes: full,
    redeemedToday: redeemed,
    futureReservations: futureRez,
  });
}
