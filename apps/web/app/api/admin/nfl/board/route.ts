import { NextRequest, NextResponse } from "next/server";
import { listNflGames } from "~/features/nfl/espn.server";
import { claimsOverlapping } from "~/features/nfl/claims.server";
import { allBlocksForCenter } from "~/features/nfl/blocks";
import {
  BOWLING_WEB_HORIZON_DAYS,
  addDays,
  centerHoursForDate,
  todayYmd,
} from "~/features/booking/service/bowling-hours";
import { gameLabel, sellableGames, windowFitsHours, windowStartDateEt } from "~/features/nfl";

/**
 * GET /api/admin/nfl/board?centerId=9172[&from=YYYY-MM-DD&to=YYYY-MM-DD]
 *
 * Front-desk view of game day: for each date, which game each lane block is
 * committed to and how many parties are on it.
 *
 * STAFF-FACING, so it DOES expose blocks and lane numbers. The guest-facing
 * picker never does — a customer sees "available" or "sold out" and is never
 * told which game another party is watching or how they are grouped.
 *
 * Read-only. Protected by x-admin-token like the other admin routes.
 */

export const dynamic = "force-dynamic";

const ADMIN_TOKEN = process.env.ADMIN_SECRET_TOKEN;

function authorized(req: NextRequest): boolean {
  if (!ADMIN_TOKEN) return false;
  return req.headers.get("x-admin-token") === ADMIN_TOKEN;
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const centerId = Number(req.nextUrl.searchParams.get("centerId") ?? "9172");
  if (!Number.isFinite(centerId)) {
    return NextResponse.json({ error: "centerId must be a number" }, { status: 400 });
  }

  const from = req.nextUrl.searchParams.get("from") ?? todayYmd();
  const to = req.nextUrl.searchParams.get("to") ?? addDays(from, BOWLING_WEB_HORIZON_DAYS);

  const blocks = allBlocksForCenter(centerId);
  if (blocks.length === 0) {
    return NextResponse.json({
      centerId,
      range: { from, to },
      blocks: [],
      dates: [],
      note: "No lane blocks are modelled for this center, so NFL game day cannot be sold here.",
    });
  }

  const games = await listNflGames(from, to);
  const nowMs = Date.now();
  const sellableIds = new Set(
    sellableGames({
      games,
      nowMs,
      hoursForDate: (d) => centerHoursForDate(centerId, d),
    }).map((g) => g.id),
  );

  // Claims are per-window, so ask once per game rather than once per date —
  // two games on the same date can hold different blocks.
  const rows = await Promise.all(
    games.map(async (g) => {
      const claims = await claimsOverlapping(centerId, g);
      const hours = centerHoursForDate(centerId, windowStartDateEt(g));
      const unsellable = windowFitsHours(g, hours);
      return {
        gameId: g.id,
        dateEt: g.dateEt,
        kickoffIso: g.kickoffIso,
        matchup: gameLabel(g),
        network: g.network,
        week: g.week,
        laneWindowOpensEt: windowStartDateEt(g),
        sellable: sellableIds.has(g.id),
        // Why it cannot be sold, when it cannot: "before-open" is the ~9:30 AM
        // London kickoff; past games simply fall out of the sellable set.
        blockedReason: unsellable ?? (sellableIds.has(g.id) ? null : "past-or-too-soon"),
        // Blocks committed to THIS game, and blocks held by something else in
        // an overlapping window (what actually stops a third game selling).
        blocksOnThisGame: claims.filter((c) => c.gameId === g.id).map((c) => c.blockId),
        blocksHeldByOtherGames: claims
          .filter((c) => c.gameId !== g.id)
          .map((c) => ({ blockId: c.blockId, gameId: c.gameId })),
      };
    }),
  );

  const byDate = new Map<string, typeof rows>();
  for (const r of rows) {
    if (!byDate.has(r.dateEt)) byDate.set(r.dateEt, []);
    byDate.get(r.dateEt)!.push(r);
  }

  return NextResponse.json({
    centerId,
    range: { from, to },
    blocks: blocks.map((b) => ({
      id: b.id,
      label: b.label,
      lanes: b.lanes,
      kind: b.kind,
      sellable: b.enabled,
    })),
    concurrentGameCapacity: blocks.filter((b) => b.enabled).length,
    dates: [...byDate.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([dateEt, games]) => ({ dateEt, games })),
  });
}
