import { NextResponse } from "next/server";
import { fixturesWithLiveTeams } from "~/features/world-cup/live-teams";

/**
 * GET /api/world-cup/fixtures
 *
 * The World Cup fixture table with TBD matchups live-filled from the ESPN
 * scoreboard (see features/world-cup/live-teams.ts). Display data only —
 * the match picker renders it; booking validation stays config-driven off
 * the committed table. Fail-soft: on any feed problem this returns the
 * committed fixtures unchanged (nulls render "Teams TBD").
 */
export async function GET() {
  const fixtures = await fixturesWithLiveTeams();
  return NextResponse.json(
    { fixtures },
    {
      headers: {
        // Fresh enough for match-day (server cache also holds it 1h in Redis);
        // stale-while-revalidate keeps the picker snappy.
        "cache-control": "public, s-maxage=300, stale-while-revalidate=600",
      },
    },
  );
}
