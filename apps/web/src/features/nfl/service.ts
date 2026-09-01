/**
 * NFL Ticket on NeoVerse — server-side validation, line items and staff strings.
 *
 * The reserve rails call `validateNflBooking` BEFORE any Square or QAMF write.
 * Prices come from Neon and Square regardless, so a client cannot profit by
 * forging a slug or a time; what this guard enforces is the BUSINESS rule — a
 * booking must sit exactly on a real game's lane window, at a center that sells
 * the package, inside trading hours, and still in the future. Fail-closed.
 *
 * Deliberately PURE. The caller fetches the game from `nfl_games` by the id the
 * client sent and hands it in, so the kickoff being validated against always
 * comes from OUR database and never from the request body. That is what makes
 * "re-derive, never trust" true here: a forged kickoff simply will not match the
 * row, and a forged id will not resolve.
 */
import {
  NFL_LEAD_MINUTES,
  NFL_WINDOW_MINUTES,
  gameLabel,
  gameMatchesBookedAt,
  isNflSlug,
  windowFitsHours,
  windowStartMs,
  type NflGame,
} from "./schedule";
import { maxLanesPerBooking } from "./blocks";
import { nflCenterEnabled } from "./flags";

/** Typed so the reserve routes can map it to a 4xx instead of a 500. */
export class NflReservationError extends Error {
  readonly code = "NFL_INVALID";
  constructor(message: string) {
    super(message);
    this.name = "NflReservationError";
  }
}

/** Is this cart item an NFL Ticket booking? (slug-prefix keyed.) */
export function isNflBowlingItem(item: { experienceSlug?: string | null }): boolean {
  return isNflSlug(item.experienceSlug);
}

/**
 * Throws `NflReservationError` unless every one of these holds:
 *  - the center sells the package (kill switch + a block model exists),
 *  - `bookedAt` is EXACTLY this game's lane-open instant,
 *  - the lane window fits the center's trading hours that day,
 *  - lane-open is still in the future,
 *  - the party is not asking for more lanes than one block holds.
 *
 * Returns the game so callers can stamp and display it.
 *
 * Note the ORDER. Center first, because a stale client session pointing at a
 * center we no longer sell should say so rather than complain about a time. The
 * headcount check is last: it is the only one the guest can act on directly, and
 * burying it behind a generic failure would send them to the phone instead of
 * back a step.
 */
export function validateNflBooking(args: {
  /** Fetched from `nfl_games` by the client's game id — never reconstructed. */
  game: NflGame | null | undefined;
  centerId: number | null | undefined;
  bookedAt: string | null | undefined;
  /** Trading hours for the date the LANES OPEN, 0-26 notation. */
  hours: { open: number; close: number };
  laneCount?: number;
  nowMs?: number;
}): NflGame {
  const nowMs = args.nowMs ?? Date.now();

  if (!nflCenterEnabled(args.centerId)) {
    throw new NflReservationError("NFL Ticket isn't available at this location right now.");
  }
  if (!args.game) {
    throw new NflReservationError("That game is no longer on the schedule — pick another.");
  }
  if (!args.bookedAt) {
    throw new NflReservationError("NFL Ticket needs a game to set the lane time.");
  }
  if (!gameMatchesBookedAt(args.game, args.bookedAt)) {
    throw new NflReservationError(
      `NFL Ticket lanes open exactly ${NFL_LEAD_MINUTES} minutes before kickoff.`,
    );
  }

  const unfit = windowFitsHours(args.game, args.hours);
  if (unfit === "before-open") {
    throw new NflReservationError("That game starts before we open — pick a later one.");
  }
  if (unfit === "after-close") {
    throw new NflReservationError("That game runs past closing time — pick an earlier one.");
  }

  if (windowStartMs(args.game) <= nowMs) {
    throw new NflReservationError("Those lanes have already opened — pick an upcoming game.");
  }

  const maxLanes = maxLanesPerBooking(args.centerId!);
  if (args.laneCount != null && maxLanes > 0 && args.laneCount > maxLanes) {
    // One party must not swallow both blocks and lock every other game out.
    throw new NflReservationError(
      `NFL Ticket seats up to ${maxLanes} lanes per booking — call us for a bigger group.`,
    );
  }

  return args.game;
}

/* ───────────────────────────── line items ───────────────────────────── */

/** The slice of a bowling experience item the line builder needs (the client
 *  shape from GET /api/bowling/v2/experiences). */
export interface NflExperienceItemLike {
  squareProductId: number;
  quantity: number;
  label: string;
  priceCents: number;
  depositPct: number;
  squareCatalogObjectId?: string;
  sortOrder: number;
}

/**
 * Cart lines for one NFL lane window.
 *
 * EVERY item scales × laneCount, which is the whole per-lane pricing model: two
 * lanes is two lane charges, two pizzas, twenty wings and two pitchers. The
 * PRIMARY (sortOrder 0) label carries the matchup, because that label becomes
 * the Neon line label and is what the confirmation email and receipt show as the
 * experience — so the guest's receipt says which game they booked.
 */
export function buildNflLineItems(
  items: readonly NflExperienceItemLike[],
  laneCount: number,
  game: Pick<NflGame, "awayTeam" | "homeTeam">,
): Array<{
  squareProductId: number;
  quantity: number;
  label: string;
  priceCents: number;
  depositPct: number;
  squareCatalogObjectId?: string;
}> {
  const lanes = Math.max(1, laneCount);
  return items.map((ei) => ({
    squareProductId: ei.squareProductId,
    quantity: ei.quantity * lanes,
    label: ei.sortOrder === 0 ? `${ei.label} — ${gameLabel(game)}` : ei.label,
    priceCents: ei.priceCents,
    depositPct: ei.depositPct,
    squareCatalogObjectId: ei.squareCatalogObjectId,
  }));
}

/* ──────────────────── staff-facing strings (Conqueror) ──────────────── */

/** Kickoff as "Sun, Sep 13 1:00 PM" for staff surfaces. */
export function gameStaffLabel(game: Pick<NflGame, "kickoffIso">): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(game.kickoffIso));
}

/**
 * Conqueror reservation Title. Prefixed so an NFL lane is unmistakable on the
 * grid at a glance — the same trick World Cup used with "Futbal", which front
 * desk asked for after a weekend of not being able to tell the packages apart.
 */
export function nflQamfTitle(guestName: string, players: number): string {
  return `NFL ${guestName} (${players}p)`;
}

/**
 * Lead line for the Conqueror Notes.
 *
 * Names the BLOCK as well as the game, because the block is the one thing front
 * desk cannot work out for themselves — the lane assignment tells them where the
 * party sits, but not which screen has to be showing what.
 */
export function nflQamfBanner(
  game: Pick<NflGame, "awayTeam" | "homeTeam" | "kickoffIso">,
  blockLabel: string,
): string {
  const hours = NFL_WINDOW_MINUTES / 60;
  return (
    `*** NFL TICKET: ${gameLabel(game)} — ${gameStaffLabel(game)} kickoff ` +
    `on ${blockLabel} (${hours}-hr window, paid online) ***`
  );
}
