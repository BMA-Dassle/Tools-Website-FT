/**
 * NFL Ticket board — group the day's bookings the way front desk needs them.
 *
 * BY GAME, then by BLOCK. That ordering is the whole point. A lane number tells
 * staff where a party sits; it does not tell them which screen owes that party
 * which game, and getting that wrong is the one failure this package can
 * produce that a guest will notice immediately.
 *
 * Mirrors combo-board.ts (the VIP Experience grouping) in shape, deliberately,
 * so the two boards read alike.
 *
 * Pure — no fetching, no React — so the grouping is unit-testable rather than
 * trapped in a component.
 */

import type { Reservation } from "./types";

export interface NflPartyRow {
  reservation: Reservation;
  /** Lanes QAMF actually seated them on, ascending. */
  lanes: number[];
  /** True when the pin failed — this party needs reseating by hand. */
  needsReseat: boolean;
  reseatReason: string | null;
}

export interface NflBlockGroup {
  blockId: string;
  blockLabel: string;
  parties: NflPartyRow[];
  /** Bowlers across every party on this block. */
  players: number;
  /** Distinct lanes committed on this block. */
  lanes: number[];
}

export interface NflGameGroup {
  gameId: string;
  label: string;
  kickoffIso: string;
  /** ET wall-clock the lanes open — what staff set the screen by. */
  laneOpenEt: string;
  blocks: NflBlockGroup[];
  parties: number;
  players: number;
  /** Any party on this game that is sitting outside its block. */
  needsAttention: boolean;
}

/** The NFL stamp, or null when this row is not an NFL Ticket booking. */
export function nflStampOf(r: Reservation) {
  const nfl = r.bookingMetadata?.nfl;
  return nfl && typeof nfl.gameId === "string" ? nfl : null;
}

/** Is this row an NFL Ticket booking? */
export function isNflReservation(r: Reservation): boolean {
  return nflStampOf(r) !== null;
}

/** Lane numbers off the day-of order stamp ("12" or "12,13"), ascending. */
function lanesOf(r: Reservation): number[] {
  const raw = (r as { dayofOrderLane?: string | null }).dayofOrderLane;
  if (!raw) return [];
  return String(raw)
    .split(",")
    .map((n) => Number(n.trim()))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);
}

/**
 * Group NFL reservations for the board.
 *
 * Cancelled rows are dropped: a cancelled party holds no lane and showing it
 * under a block would overstate how full that block is, which is the number
 * staff use to decide whether they can still sell the game.
 */
export function buildNflGameGroups(reservations: readonly Reservation[]): NflGameGroup[] {
  const byGame = new Map<string, NflGameGroup>();

  for (const r of reservations) {
    const nfl = nflStampOf(r);
    if (!nfl) continue;
    if (r.status === "cancelled") continue;

    let game = byGame.get(nfl.gameId);
    if (!game) {
      game = {
        gameId: nfl.gameId,
        label: nfl.label,
        kickoffIso: nfl.kickoffIso,
        laneOpenEt: nfl.laneOpenEt,
        blocks: [],
        parties: 0,
        players: 0,
        needsAttention: false,
      };
      byGame.set(nfl.gameId, game);
    }

    let block = game.blocks.find((b) => b.blockId === nfl.blockId);
    if (!block) {
      block = {
        blockId: nfl.blockId,
        blockLabel: nfl.blockLabel,
        parties: [],
        players: 0,
        lanes: [],
      };
      game.blocks.push(block);
    }

    const lanes = lanesOf(r);
    const pin = nfl.pin ?? null;
    // No pin recorded is NOT a problem — QAMF may have seated them inside the
    // block unaided, which is the common case on a quiet day. Only an explicit
    // failure asks for a human.
    const needsReseat = pin != null && pin.pinned === false;

    block.parties.push({
      reservation: r,
      lanes,
      needsReseat,
      reseatReason: needsReseat ? (pin?.reason ?? "unknown") : null,
    });
    block.players += r.playerCount ?? 0;
    for (const l of lanes) if (!block.lanes.includes(l)) block.lanes.push(l);
    game.parties += 1;
    game.players += r.playerCount ?? 0;
    if (needsReseat) game.needsAttention = true;
  }

  for (const g of byGame.values()) {
    g.blocks.sort((a, b) => a.blockId.localeCompare(b.blockId));
    for (const b of g.blocks) {
      b.lanes.sort((x, y) => x - y);
      // Earliest booking first, so the party who claimed the block reads first.
      b.parties.sort((a, c) =>
        (a.reservation.insertedAt ?? "").localeCompare(c.reservation.insertedAt ?? ""),
      );
    }
  }

  // Kickoff order — the order the screens have to change.
  return [...byGame.values()].sort((a, b) => a.kickoffIso.localeCompare(b.kickoffIso));
}

/** Distinct blocks committed across the day, for the header count. */
export function blocksInUse(groups: readonly NflGameGroup[]): number {
  const seen = new Set<string>();
  for (const g of groups) for (const b of g.blocks) seen.add(b.blockId);
  return seen.size;
}
