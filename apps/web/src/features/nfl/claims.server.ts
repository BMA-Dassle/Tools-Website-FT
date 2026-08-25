/**
 * NFL lane-block claim ledger — SERVER ONLY.
 *
 * THE PROBLEM. A VIP block is four lanes on one TV, so whoever books it first
 * fixes what it shows for that window. We must therefore know, before taking
 * money, which game each block is already committed to. QAMF cannot answer
 * that: its client has no list-reservations-in-a-range call, and its
 * availability endpoint returns time slots with no lane or lane-group
 * information at all. So this is OUR state, and this file is the only writer.
 *
 * THE DIVISION OF LABOUR, which is what keeps this honest:
 *   - this ledger owns WHICH GAME a block is showing;
 *   - QAMF still owns WHETHER A LANE IS FREE.
 * They are checked in series — the ledger admits the game, then the QAMF hold
 * proves a lane exists. Neither is asked to answer the other's question. A
 * normal (non-football) VIP booking can still take a lane inside a block, and
 * that is correctly invisible here: the hold simply fails and the card reads
 * sold out.
 *
 * RACE SAFETY WITHOUT TRANSACTIONS. Neon's HTTP transport exposes no
 * multi-statement transaction (see lib/bowling-db.ts), but a single statement is
 * atomic and Postgres exclusion constraints do the rest. `claimBlock` ends in
 * one `INSERT … ON CONFLICT DO NOTHING RETURNING`, so two guests racing for the
 * last free block cannot both win: exactly one insert lands, the loser re-reads
 * and is told sold out. No advisory locks, no retry loops, no counters that can
 * drift.
 *
 * The allocation rule (owner 2026-08-25): a block serves exactly one game per
 * overlapping window, and a game MAY spill onto a second block once its first
 * is full — better to sell both blocks to one popular game than turn parties
 * away holding a block for a second game that may never come.
 */

import { sql, isDbConfigured } from "@/lib/db";
import { blocksForCenter, type NflLaneBlock } from "./blocks";
import { gameWindow, type NflGame } from "./schedule";

/** How long a hold-stage claim survives without being confirmed. */
export const CLAIM_HOLD_TTL_MINUTES = 30;

let schemaReady = false;

export async function ensureNflSchema(): Promise<void> {
  if (schemaReady) return;
  if (!isDbConfigured()) return;
  const q = sql();

  // Synced from ESPN on a rolling horizon — see espn.server.ts.
  await q`
    CREATE TABLE IF NOT EXISTS nfl_games (
      game_id      TEXT        PRIMARY KEY,
      kickoff_at   TIMESTAMPTZ NOT NULL,
      date_et      DATE        NOT NULL,
      away_team    TEXT        NOT NULL,
      home_team    TEXT        NOT NULL,
      network      TEXT,
      week         INTEGER,
      season       INTEGER     NOT NULL,
      season_type  SMALLINT    NOT NULL,
      is_active    BOOLEAN     NOT NULL DEFAULT TRUE,
      -- Flex scheduling moves Sunday kickoffs in weeks 5-17. Once a game has a
      -- live booking its kickoff is FROZEN: a sync that sees a different time
      -- raises an ops alert instead of silently moving somebody's lanes.
      kickoff_locked BOOLEAN   NOT NULL DEFAULT FALSE,
      synced_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await q`CREATE INDEX IF NOT EXISTS nfl_games_date ON nfl_games(date_et)`;

  // btree_gist lets an exclusion constraint mix equality on the block with
  // overlap on the window. Available on Neon.
  await q`CREATE EXTENSION IF NOT EXISTS btree_gist`;

  await q`
    CREATE TABLE IF NOT EXISTS nfl_lane_block_claims (
      id              SERIAL      PRIMARY KEY,
      center_id       INTEGER     NOT NULL,
      block_id        TEXT        NOT NULL,
      game_id         TEXT        NOT NULL,
      window_range    TSTZRANGE   NOT NULL,
      -- Set while the claim is only a hold; NULL once a booking confirms it.
      hold_expires_at TIMESTAMPTZ,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      -- THE constraint. One game per block per overlapping window, enforced by
      -- Postgres rather than by application checks that can interleave.
      CONSTRAINT nfl_block_one_game_per_window
        EXCLUDE USING gist (center_id WITH =, block_id WITH =, window_range WITH &&)
    )
  `;
  await q`CREATE INDEX IF NOT EXISTS nfl_claims_game ON nfl_lane_block_claims(game_id)`;

  // Ties a reservation to the block it was seated in. Partial index mirrors the
  // combo_special_id precedent — almost every bowling row is NULL here.
  await q`ALTER TABLE bowling_reservations ADD COLUMN IF NOT EXISTS nfl_block_claim_id INTEGER`;
  await q`
    CREATE INDEX IF NOT EXISTS bowling_res_nfl_claim
      ON bowling_reservations(nfl_block_claim_id)
      WHERE nfl_block_claim_id IS NOT NULL
  `;

  schemaReady = true;
}

export interface NflBlockClaim {
  id: number;
  centerId: number;
  blockId: string;
  gameId: string;
  holdExpiresAt: string | null;
}

/** Half-open `[start, end)` tstzrange literal for a game's lane window. */
function windowLiteral(game: Pick<NflGame, "kickoffIso">): string {
  const { startMs, endMs } = gameWindow(game);
  return `[${new Date(startMs).toISOString()},${new Date(endMs).toISOString()})`;
}

/**
 * Drop claims nothing refers to any more.
 *
 * A claim is stale when no live reservation points at it AND its hold has
 * expired. Reference-counted by query rather than by a stored counter — a
 * counter would need its own concurrency story, and getting that wrong strands
 * a block for the rest of the day.
 *
 * Scoped to the window under consideration so a sweep never touches unrelated
 * days.
 */
async function reapStaleClaims(centerId: number, game: Pick<NflGame, "kickoffIso">): Promise<void> {
  const q = sql();
  await q`
    DELETE FROM nfl_lane_block_claims c
     WHERE c.center_id = ${centerId}
       AND c.window_range && ${windowLiteral(game)}::tstzrange
       AND c.hold_expires_at IS NOT NULL
       AND c.hold_expires_at < NOW()
       AND NOT EXISTS (
         SELECT 1 FROM bowling_reservations r
          WHERE r.nfl_block_claim_id = c.id
            AND r.status <> 'cancelled'
       )
  `;
}

/** Claims overlapping this game's window at this center. */
export async function claimsOverlapping(
  centerId: number,
  game: Pick<NflGame, "kickoffIso">,
): Promise<NflBlockClaim[]> {
  await ensureNflSchema();
  if (!isDbConfigured()) return [];
  const q = sql();
  const rows = await q`
    SELECT id, center_id, block_id, game_id, hold_expires_at
      FROM nfl_lane_block_claims
     WHERE center_id = ${centerId}
       AND window_range && ${windowLiteral(game)}::tstzrange
     ORDER BY id
  `;
  return rows.map((r) => ({
    id: r.id as number,
    centerId: r.center_id as number,
    blockId: r.block_id as string,
    gameId: r.game_id as string,
    holdExpiresAt: r.hold_expires_at ? new Date(r.hold_expires_at as string).toISOString() : null,
  }));
}

export type ClaimOutcome =
  | { ok: true; claim: NflBlockClaim; block: NflLaneBlock; reused: boolean }
  | { ok: false; reason: "no-blocks-configured" | "all-blocks-taken" | "db-unavailable" };

/**
 * Reserve a block for this game, or explain why not.
 *
 * Order matters and is the point:
 *   1. reap claims nothing refers to any more;
 *   2. REUSE a block already showing this game — several parties share a block,
 *      which is the normal case and must not consume a second one;
 *   3. otherwise take the first block no overlapping claim holds.
 *
 * Step 3's insert is the only place a block is committed, and the exclusion
 * constraint means a concurrent caller cannot take the same one. On conflict we
 * fall through to the next candidate rather than failing, so a race costs a
 * retry and not a lost sale.
 *
 * Capacity WITHIN the chosen block is not our business — QAMF answers that when
 * the hold is placed. See the file header.
 */
export async function claimBlock(args: {
  centerId: number;
  game: Pick<NflGame, "id" | "kickoffIso">;
  /** Confirmed at charge time; a hold-stage claim expires on its own. */
  confirmed?: boolean;
}): Promise<ClaimOutcome> {
  const { centerId, game, confirmed = false } = args;
  await ensureNflSchema();
  if (!isDbConfigured()) return { ok: false, reason: "db-unavailable" };

  const blocks = blocksForCenter(centerId);
  if (blocks.length === 0) return { ok: false, reason: "no-blocks-configured" };

  await reapStaleClaims(centerId, game);

  const existing = await claimsOverlapping(centerId, game);

  // 2. Already showing this game somewhere? Sit with them.
  const sameGame = existing.filter((c) => c.gameId === game.id);
  if (sameGame.length > 0) {
    const block = blocks.find((b) => b.id === sameGame[0].blockId);
    if (block) return { ok: true, claim: sameGame[0], block, reused: true };
  }

  // 3. First block no overlapping claim holds.
  const taken = new Set(existing.map((c) => c.blockId));
  const q = sql();
  // Bound as a parameter rather than built as SQL `NOW() + INTERVAL`, so no
  // interval string is ever interpolated into the statement.
  const holdExpiresAt = confirmed
    ? null
    : new Date(Date.now() + CLAIM_HOLD_TTL_MINUTES * 60_000).toISOString();

  for (const block of blocks) {
    if (taken.has(block.id)) continue;
    const rows = await q`
      INSERT INTO nfl_lane_block_claims
        (center_id, block_id, game_id, window_range, hold_expires_at)
      VALUES (
        ${centerId}, ${block.id}, ${game.id}, ${windowLiteral(game)}::tstzrange,
        ${holdExpiresAt}
      )
      -- BARE "DO NOTHING" on purpose. Postgres only accepts a named conflict
      -- target for UNIQUE constraints; naming an EXCLUSION constraint is a
      -- syntax error. The untargeted form is the one that catches an exclusion
      -- violation, and the serial primary key cannot conflict, so nothing else
      -- is being swallowed here.
      ON CONFLICT DO NOTHING
      RETURNING id, center_id, block_id, game_id, hold_expires_at
    `;
    if (rows.length === 0) continue; // lost the race for this block — try the next
    const r = rows[0];
    return {
      ok: true,
      reused: false,
      block,
      claim: {
        id: r.id as number,
        centerId: r.center_id as number,
        blockId: r.block_id as string,
        gameId: r.game_id as string,
        holdExpiresAt: r.hold_expires_at
          ? new Date(r.hold_expires_at as string).toISOString()
          : null,
      },
    };
  }

  return { ok: false, reason: "all-blocks-taken" };
}

/** Promote a hold-stage claim to confirmed, and tie the reservation to it. */
export async function confirmClaim(claimId: number, reservationId: number): Promise<void> {
  await ensureNflSchema();
  if (!isDbConfigured()) return;
  const q = sql();
  await q`UPDATE nfl_lane_block_claims SET hold_expires_at = NULL WHERE id = ${claimId}`;
  await q`UPDATE bowling_reservations SET nfl_block_claim_id = ${claimId} WHERE id = ${reservationId}`;
}

/**
 * Give a claim back when a hold is abandoned or a booking fails after claiming.
 *
 * Deletes only when nothing live refers to it, so releasing one party's
 * abandoned hold can never evict the other parties sharing that block.
 */
export async function releaseClaim(claimId: number): Promise<void> {
  await ensureNflSchema();
  if (!isDbConfigured()) return;
  const q = sql();
  await q`
    DELETE FROM nfl_lane_block_claims c
     WHERE c.id = ${claimId}
       AND NOT EXISTS (
         SELECT 1 FROM bowling_reservations r
          WHERE r.nfl_block_claim_id = c.id
            AND r.status <> 'cancelled'
       )
  `;
}

/**
 * Which games could still be sold at this center, given what the blocks already
 * hold?
 *
 * One query for a whole slate, so the picker can mark every card without the
 * per-card QAMF probe World Cup needed (that build deliberately probed on tap
 * only, to avoid ~48 vendor calls). QAMF is still consulted on tap — this only
 * decides whether the GAME is admissible.
 */
export async function admissibleGameIds(args: {
  centerId: number;
  games: readonly NflGame[];
}): Promise<Set<string>> {
  const { centerId, games } = args;
  await ensureNflSchema();
  const blocks = blocksForCenter(centerId);
  const out = new Set<string>();
  if (blocks.length === 0 || !isDbConfigured()) return out;

  for (const game of games) {
    const existing = await claimsOverlapping(centerId, game);
    const showingThisGame = existing.some((c) => c.gameId === game.id);
    const free = blocks.filter((b) => !existing.some((c) => c.blockId === b.id));
    if (showingThisGame || free.length > 0) out.add(game.id);
  }
  return out;
}
