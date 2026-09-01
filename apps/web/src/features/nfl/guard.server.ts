/**
 * The one chokepoint every NFL booking passes through before money moves.
 *
 * Both reserve rails call this — `unified-reserve` for mixed carts and
 * `/api/bowling/v2/reserve` for bowling-only ones. Having ONE implementation is
 * the point: the 2026-06-21 food-loss incident happened precisely because the
 * two rails did the same job in two places and only one was ever fixed.
 *
 * WHY A GAME ID IS REQUIRED, and `bookedAt` alone is not enough. Eight games
 * kick off at 1:00 PM on a normal Sunday. They share a lane-open instant, so the
 * booking time cannot say which one the party is here for — and the whole
 * feature turns on knowing that, because it decides which block they sit in and
 * what the screen shows. The id is the client's only real input, and it is
 * checked against our own row rather than trusted: we fetch the game, then
 * require `bookedAt` to be exactly that row's lane-open instant.
 *
 * ORDER OF OPERATIONS, and why the claim comes last:
 *   1. validate  — cheap, pure, no side effects
 *   2. claim     — atomic, ours, reversible
 *   3. (caller)  — QAMF hold and Square charge
 * Claiming before the vendor calls means a guest who cannot be seated has
 * already reserved a block; that is deliberate and is why the claim carries a
 * 30-minute hold expiry and why `releaseNflClaim` exists. The alternative —
 * charge first, claim after — can take money for a block that filled in the
 * meantime, which is not recoverable by a sweep.
 */

import { claimBlock, releaseClaim, confirmClaim, type NflBlockClaim } from "./claims.server";
import { getNflGame, lockGameKickoff } from "./espn.server";
import { NflReservationError, validateNflBooking } from "./service";
import type { NflLaneBlock } from "./blocks";
import type { NflGame } from "./schedule";

export interface NflGuardResult {
  game: NflGame;
  claim: NflBlockClaim;
  block: NflLaneBlock;
  /** True when the party joined a block already showing this game. */
  sharedBlock: boolean;
}

/**
 * Validate an NFL booking and reserve it a block, or throw
 * `NflReservationError` (which both rails map to a 4xx, never a 500).
 *
 * `hours` is the center's trading window for the day the LANES OPEN, in the
 * 0-26 notation the bowling code uses throughout.
 */
export async function guardNflBooking(args: {
  centerId: number | null | undefined;
  bookedAt: string | null | undefined;
  gameId: string | null | undefined;
  hours: { open: number; close: number };
  laneCount?: number;
  nowMs?: number;
}): Promise<NflGuardResult> {
  if (!args.gameId) {
    throw new NflReservationError("NFL Ticket needs a game — please re-pick your game.");
  }

  // From OUR table, by id. Everything downstream validates against this row,
  // never against anything in the request body.
  const game = await getNflGame(args.gameId);

  const validated = validateNflBooking({
    game,
    centerId: args.centerId,
    bookedAt: args.bookedAt,
    hours: args.hours,
    laneCount: args.laneCount,
    nowMs: args.nowMs,
  });

  const outcome = await claimBlock({ centerId: args.centerId!, game: validated });
  if (!outcome.ok) {
    // Deliberately vague to the guest. Which game another party is watching,
    // and how the room is grouped, is not theirs to know — staff see blocks on
    // the ops board, guests see available or sold out.
    const message =
      outcome.reason === "all-blocks-taken"
        ? "Those lanes are sold out for this game — try another game or another day."
        : "NFL Ticket isn't available at this location right now.";
    throw new NflReservationError(message);
  }

  return {
    game: validated,
    claim: outcome.claim,
    block: outcome.block,
    sharedBlock: outcome.reused,
  };
}

/**
 * Give the block back when the booking fails after the guard passed.
 *
 * Best-effort by design: a booking that already succeeded must never be undone
 * because the tidy-up threw, and an un-released claim expires on its own within
 * 30 minutes. Callers should invoke this from a catch, not gate on it.
 */
export async function releaseNflClaim(claimId: number): Promise<void> {
  try {
    await releaseClaim(claimId);
  } catch (err) {
    console.warn(`[nfl] failed to release claim ${claimId} (it will expire):`, err);
  }
}

/**
 * Promote the claim once the booking is real, and freeze the game's kickoff.
 *
 * The freeze is what stops the nightly ESPN sync moving a booked party's lanes
 * when the league flexes a Sunday kickoff — from then on a changed time is
 * reported for a human instead of written.
 *
 * Best-effort for the same reason as above: the guest has paid and been
 * confirmed by this point, so nothing here may throw back into the booking.
 * An unconfirmed claim still holds the block until its hold expires, and the
 * reservation row carries the block id regardless.
 */
export async function confirmNflBooking(args: {
  claimId: number;
  reservationId: number;
  gameId: string;
}): Promise<void> {
  try {
    await confirmClaim(args.claimId, args.reservationId);
  } catch (err) {
    console.warn(`[nfl] failed to confirm claim ${args.claimId}:`, err);
  }
  try {
    await lockGameKickoff(args.gameId);
  } catch (err) {
    console.warn(`[nfl] failed to lock kickoff for game ${args.gameId}:`, err);
  }
}

/** What gets stamped onto `bowling_reservations.booking_metadata.nfl`. */
export function nflBookingMetadata(r: NflGuardResult, bookedAt: string) {
  return {
    gameId: r.game.id,
    label: `${r.game.awayTeam} at ${r.game.homeTeam}`,
    kickoffIso: r.game.kickoffIso,
    laneOpenEt: bookedAt,
    blockId: r.block.id,
    blockLabel: r.block.label,
    claimId: r.claim.id,
  };
}
