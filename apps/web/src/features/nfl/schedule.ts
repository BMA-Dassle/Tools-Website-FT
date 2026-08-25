/**
 * NFL game-day bowling — schedule types and pure window maths.
 *
 * Client AND server import this file, so the server never trusts a
 * client-supplied kickoff: it re-derives the game from the validated `bookedAt`.
 * Same discipline as features/world-cup/fixtures.ts, with two deliberate
 * departures learned from that build:
 *
 *   1. NO hardcoded fixture table. World Cup could hand-maintain 16 knockout
 *      matches; an NFL season is ~272 games plus playoffs, and Sunday kickoffs
 *      MOVE (flex scheduling, weeks 5-17). The schedule lives in `nfl_games`,
 *      synced from ESPN — see espn.server.ts.
 *   2. NO fixed UTC offset. World Cup could get away with a hardcoded -04:00
 *      because the tournament sat inside EDT. An NFL season runs September to
 *      February and crosses the DST boundary on the first Sunday of November,
 *      so every instant is derived with real America/New_York maths.
 *
 * All helpers take `nowMs` explicitly — no module-level Date.now() — so they are
 * pure and unit-testable.
 */

import { etOffsetForLocalDate } from "@/lib/et-time";

/** Lanes open this long BEFORE kickoff (owner 2026-08-25). */
export const NFL_LEAD_MINUTES = 15;

/**
 * Lane window sold per game (owner 2026-08-25).
 *
 * 180 is not an arbitrary round number — it is the only length that lets a VIP
 * block turn over three times on a Sunday. The early slate ends 15:45 and the
 * late slate starts 15:50, five minutes clear. At 195 the early window collides
 * with 4:05 kickoffs; at 210 it collides with every late kickoff and Sunday
 * capacity halves.
 */
export const NFL_WINDOW_MINUTES = 180;

/**
 * Stop offering a game this close to (or past) its lane-open time. The
 * availability route cannot probe a start nearer than now+15min, so a smaller
 * cutoff would only surface cards that can never hold.
 */
export const NFL_BOOKING_CUTOFF_MS = 15 * 60_000;

/** ESPN season type: 1 preseason, 2 regular season, 3 postseason. */
export type NflSeasonType = 1 | 2 | 3;

export interface NflGame {
  /** ESPN event id — stable, persisted into booking metadata. Never renumber. */
  id: string;
  /** Kickoff as a true instant (ESPN gives UTC). */
  kickoffIso: string;
  /** ET calendar date of KICKOFF, YYYY-MM-DD. */
  dateEt: string;
  awayTeam: string;
  homeTeam: string;
  /** "FOX", "CBS", "NBC", "Prime Video", "Netflix"… null when unannounced. */
  network: string | null;
  week: number | null;
  season: number;
  seasonType: NflSeasonType;
}

/** "Chiefs at Bills" — guest-facing, text only (no league or team logos). */
export function gameLabel(g: Pick<NflGame, "awayTeam" | "homeTeam">): string {
  return `${g.awayTeam} at ${g.homeTeam}`;
}

/** Kickoff as epoch ms. */
export function kickoffMs(g: Pick<NflGame, "kickoffIso">): number {
  return Date.parse(g.kickoffIso);
}

/** When the lanes open: kickoff − NFL_LEAD_MINUTES. */
export function windowStartMs(g: Pick<NflGame, "kickoffIso">): number {
  return kickoffMs(g) - NFL_LEAD_MINUTES * 60_000;
}

/** When the lanes are done: start + NFL_WINDOW_MINUTES. */
export function windowEndMs(g: Pick<NflGame, "kickoffIso">): number {
  return windowStartMs(g) + NFL_WINDOW_MINUTES * 60_000;
}

/** Half-open interval the booking occupies, `[start, end)`. */
export function gameWindow(g: Pick<NflGame, "kickoffIso">): { startMs: number; endMs: number } {
  return { startMs: windowStartMs(g), endMs: windowEndMs(g) };
}

/** Do two games' lane windows overlap? Touching end-to-start does NOT. */
export function windowsOverlap(
  a: Pick<NflGame, "kickoffIso">,
  b: Pick<NflGame, "kickoffIso">,
): boolean {
  const x = gameWindow(a);
  const y = gameWindow(b);
  return x.startMs < y.endMs && y.startMs < x.endMs;
}

/** ET wall-clock parts for an instant. */
function etParts(ms: number): { date: string; hour: number; minute: number } {
  const p = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })
    .formatToParts(new Date(ms))
    .reduce<Record<string, string>>((acc, part) => ((acc[part.type] = part.value), acc), {});
  // Intl can render midnight as hour 24; normalize so comparisons hold.
  const hour = Number(p.hour) % 24;
  return { date: `${p.year}-${p.month}-${p.day}`, hour, minute: Number(p.minute) };
}

/**
 * The `bookedAt` string QAMF is given: ET wall-clock with the TRUE offset for
 * that date.
 *
 * Conqueror accepts an off-grid minute exactly — probed live 2026-08-25, where
 * 15:50, 16:10 and 20:05 all came back unrounded — so "15 minutes before
 * kickoff" books literally for every NFL slot (1:00, 4:05, 4:25, 8:15, 8:20,
 * 8:35). No snapping to a :00/:15/:30/:45 grid.
 */
export function bookedAtFor(g: Pick<NflGame, "kickoffIso">): string {
  const { date, hour, minute } = etParts(windowStartMs(g));
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date}T${pad(hour)}:${pad(minute)}:00${etOffsetForLocalDate(date)}`;
}

/** ET date the lanes OPEN on. Differs from `dateEt` only across midnight. */
export function windowStartDateEt(g: Pick<NflGame, "kickoffIso">): string {
  return etParts(windowStartMs(g)).date;
}

/**
 * Does `bookedAtIso` name EXACTLY this game's lane-open instant?
 *
 * Compared as instants, not strings: the client and the DB can legitimately
 * render the same moment with a different offset or precision, and a string
 * compare would reject a valid booking (or, worse, be loosened until it accepts
 * an invalid one).
 */
export function gameMatchesBookedAt(g: Pick<NflGame, "kickoffIso">, bookedAtIso: string): boolean {
  const ms = Date.parse(bookedAtIso);
  return Number.isFinite(ms) && ms === windowStartMs(g);
}

/** Games whose lane-open is still far enough out to hold. */
export function upcomingFrom(games: readonly NflGame[], nowMs: number): NflGame[] {
  return games.filter((g) => windowStartMs(g) - NFL_BOOKING_CUTOFF_MS > nowMs);
}

/** Why a game cannot be sold at a center, or null when it can. */
export type NflUnsellableReason = "before-open" | "after-close";

/**
 * Does the lane window fit inside the center's trading hours?
 *
 * This is not hypothetical. The NFL plays roughly five London games a season
 * kicking off 9:30 AM ET; lanes would need to open at 9:15 and HeadPinz opens
 * at 11. Those games must never appear as bookable.
 *
 * `hours` is `{ open, close }` in the 0-26 notation the bowling code uses
 * throughout (24 = midnight, 26 = 2 AM), so a window running past midnight
 * compares correctly on a Friday or Saturday.
 */
export function windowFitsHours(
  g: Pick<NflGame, "kickoffIso">,
  hours: { open: number; close: number },
): NflUnsellableReason | null {
  const start = etParts(windowStartMs(g));
  const startMin = start.hour * 60 + start.minute;
  // A start between midnight and ~6 AM belongs to the PREVIOUS trading day, so
  // express it as 24h+ to match the close notation.
  const startMinAdj = start.hour < 6 ? startMin + 24 * 60 : startMin;
  if (startMinAdj < hours.open * 60) return "before-open";
  if (startMinAdj + NFL_WINDOW_MINUTES > hours.close * 60) return "after-close";
  return null;
}

/** Games that are both upcoming and inside trading hours for their date. */
export function sellableGames(args: {
  games: readonly NflGame[];
  nowMs: number;
  hoursForDate: (dateEt: string) => { open: number; close: number };
}): NflGame[] {
  return upcomingFrom(args.games, args.nowMs).filter(
    (g) => windowFitsHours(g, args.hoursForDate(windowStartDateEt(g))) === null,
  );
}

/** Distinct ET dates present in a game list, ascending. */
export function datesOf(games: readonly NflGame[]): string[] {
  return [...new Set(games.map((g) => g.dateEt))].sort();
}
