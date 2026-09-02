import { NextRequest, NextResponse } from "next/server";
import { listNflGames } from "~/features/nfl/espn.server";
import { admissibleGameIds } from "~/features/nfl/claims.server";
import {
  bookedAtFor,
  datesOf,
  gameLabel,
  nflCenterEnabled,
  nflSlugForGame,
  sellableGames,
  windowStartDateEt,
  type NflGame,
} from "~/features/nfl";
import { centerHoursForDate } from "~/features/booking/service/bowling-hours";

/**
 * GET /api/bowling/v2/nfl/games
 *
 * Guest-facing. Two modes:
 *
 *   ?centerId=9172&date=YYYY-MM-DD
 *     The games on that date, each with the lane-open time it would book and
 *     whether it can still be sold. Feeds the game picker.
 *
 *   ?centerId=9172&from=YYYY-MM-DD&to=YYYY-MM-DD
 *     Just the dates that have a sellable game. Feeds the Experience-screen
 *     card, which must appear only on days there is actually football — cheap
 *     because it skips the per-game claim lookup.
 *
 * WHAT "sellable" MEANS HERE, and what it does not. It means the game is
 * upcoming, its window fits trading hours, and a VIP block is either already
 * showing it or still free. It does NOT mean a lane is free — QAMF owns that
 * and is asked on tap. So a card can read available and still fail to hold, and
 * that is correct: the alternative is fanning out a vendor probe per card, which
 * is the ~48-call pre-probe the World Cup build deliberately refused.
 *
 * Never says WHY a game is unavailable beyond sold-out. Which game another party
 * is watching, and how the room is grouped, is staff information — the ops board
 * shows blocks, guests see available or sold out.
 */

export const dynamic = "force-dynamic";

interface GameCard {
  id: string;
  kickoffIso: string;
  /** ET date the LANES OPEN — what the picker groups by. */
  dateEt: string;
  matchup: string;
  network: string | null;
  week: number | null;
  /** The exact `bookedAt` this card would reserve. */
  laneOpenIso: string;
  /** Experience slug that sells it (day-banded — see nflSlugForGame). */
  experienceSlug: string;
  soldOut: boolean;
}

function toCard(g: NflGame, admissible: Set<string>): GameCard {
  return {
    id: g.id,
    kickoffIso: g.kickoffIso,
    dateEt: windowStartDateEt(g),
    matchup: gameLabel(g),
    network: g.network,
    week: g.week,
    laneOpenIso: bookedAtFor(g),
    experienceSlug: nflSlugForGame(g),
    soldOut: !admissible.has(g.id),
  };
}

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const centerId = Number(sp.get("centerId"));
  if (!Number.isFinite(centerId)) {
    return NextResponse.json({ error: "centerId is required" }, { status: 400 });
  }

  // Fail closed and quietly: a center that does not sell the package returns an
  // empty slate rather than an error, so a stale client just shows no card.
  if (!nflCenterEnabled(centerId)) {
    return NextResponse.json(
      { centerId, games: [], dates: [] },
      { headers: { "cache-control": "public, s-maxage=300" } },
    );
  }

  const hoursFor = (dateEt: string) => centerHoursForDate(centerId, dateEt);
  const nowMs = Date.now();

  // ── Date-range mode: which days have football worth showing a card for ──
  const from = sp.get("from");
  const to = sp.get("to");
  if (from && to) {
    const games = await listNflGames(from, to);
    const sellable = sellableGames({ games, nowMs, hoursForDate: hoursFor });
    return NextResponse.json(
      { centerId, dates: datesOf(sellable.map((g) => ({ ...g, dateEt: windowStartDateEt(g) }))) },
      // Short: this only changes as games pass or the schedule syncs, and a
      // stale card is corrected the moment the picker opens.
      { headers: { "cache-control": "public, s-maxage=300, stale-while-revalidate=600" } },
    );
  }

  // ── Single-date mode: the picker ────────────────────────────────────────
  const date = sp.get("date");
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return NextResponse.json(
      { error: "pass either date=YYYY-MM-DD or from=&to=" },
      { status: 400 },
    );
  }

  // Kickoff can land on the next UTC day, so widen by one and filter back to
  // the day the LANES OPEN — an 8:20 PM Sunday game must group under Sunday.
  const next = new Date(`${date}T12:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  const games = (await listNflGames(date, next.toISOString().slice(0, 10))).filter(
    (g) => windowStartDateEt(g) === date,
  );

  const sellable = sellableGames({ games, nowMs, hoursForDate: hoursFor });
  const admissible = await admissibleGameIds({ centerId, games: sellable });

  return NextResponse.json(
    { centerId, date, games: sellable.map((g) => toCard(g, admissible)) },
    // Deliberately short: admissibility moves as parties book, and a card that
    // reads available after the last block went is a wasted tap.
    { headers: { "cache-control": "public, s-maxage=30, stale-while-revalidate=60" } },
  );
}
