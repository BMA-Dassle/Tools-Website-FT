import { NextRequest, NextResponse } from "next/server";
import { verifyCron } from "@/lib/cron-auth";
import { syncNflSchedule } from "~/features/nfl/espn.server";
import {
  BOWLING_WEB_HORIZON_DAYS,
  addDays,
  todayYmd,
} from "~/features/booking/service/bowling-hours";

/**
 * GET /api/cron/nfl-schedule-sync
 *
 * Keeps `nfl_games` in step with ESPN across the booking horizon. One ranged
 * request covers the whole window (verified 2026-08-25: the scoreboard accepts
 * `dates=YYYYMMDD-YYYYMMDD`), so this is a single upstream call, not one per day.
 *
 * Horizon is BOWLING_WEB_HORIZON_DAYS — the same constant every bowling
 * calendar caps on. Syncing further would offer games QAMF will not sell yet;
 * syncing less would hide games the calendar already shows.
 *
 * FLEX SCHEDULING is the thing to watch. The NFL moves Sunday kickoffs in weeks
 * 5-17, so a sync that blindly wrote the incoming time would move the lanes of
 * anyone already booked. syncNflSchedule refuses to touch a game whose kickoff
 * is locked and reports the mismatch instead — those come back in
 * `lockedConflicts` and need a human, because the resolution (move the party, or
 * refund) is not ours to pick.
 *
 * ?dryRun=1 — fetch and report without writing.
 *
 * Registered in vercel.json. Nightly is plenty: the schedule is published months
 * ahead and flex decisions land days out, never minutes.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const unauthorized = verifyCron(req);
  if (unauthorized) return unauthorized;

  const today = todayYmd();
  const to = addDays(today, BOWLING_WEB_HORIZON_DAYS);

  if (req.nextUrl.searchParams.get("dryRun") === "1") {
    const { fetchEspnRange } = await import("~/features/nfl/espn.server");
    const { games, error } = await fetchEspnRange(today, to);
    return NextResponse.json({
      ok: !error,
      dryRun: true,
      range: { from: today, to },
      error,
      fetched: games.length,
      games: games.map((g) => ({
        id: g.id,
        dateEt: g.dateEt,
        kickoffIso: g.kickoffIso,
        matchup: `${g.awayTeam} at ${g.homeTeam}`,
        network: g.network,
        week: g.week,
        seasonType: g.seasonType,
      })),
    });
  }

  const result = await syncNflSchedule({ fromYmd: today, toYmd: to });

  if (result.lockedConflicts.length > 0) {
    // Loud in the logs on purpose — a flexed kickoff on a BOOKED game is an ops
    // decision, and the sync deliberately did not act on it.
    console.warn(
      `[nfl-schedule-sync] ${result.lockedConflicts.length} booked game(s) moved upstream and were NOT updated:`,
      JSON.stringify(result.lockedConflicts),
    );
  }

  console.log(
    `[nfl-schedule-sync] range=${today}..${to} fetched=${result.fetched} ` +
      `inserted=${result.inserted} updated=${result.updated} ` +
      `deactivated=${result.deactivated} conflicts=${result.lockedConflicts.length}`,
  );

  return NextResponse.json(
    { ...result, range: { from: today, to } },
    {
      status: result.ok ? 200 : 502,
    },
  );
}
