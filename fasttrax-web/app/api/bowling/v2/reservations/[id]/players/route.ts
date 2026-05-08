import { NextRequest, NextResponse } from "next/server";
import {
  getBowlingReservation,
  getReservationPlayersWithShoeAllowance,
  insertReservationPlayers,
  upsertReservationPlayer,
} from "@/lib/bowling-db";
import { upsertMemberPref } from "@/lib/kbf-prefs";
import { setLanePlayers } from "@/lib/qamf-bowling";

/**
 * GET  /api/bowling/v2/reservations/[id]/players
 * PATCH /api/bowling/v2/reservations/[id]/players
 *
 * GET — returns the player rows for this reservation plus shoePairsAllowed
 * (the number of addon_shoe pairs purchased), which the confirmation page
 * uses to prevent assigning more shoe sizes than pairs bought.
 *
 * PATCH — saves updated shoe sizes, bumpers, and names (open bowling only).
 * After saving to Neon it:
 *   1. Calls QAMF setLanePlayers (best-effort — non-fatal on failure)
 *   2. Writes KBF member prefs back for any player with a kbf_pass_id
 *      so shoe size + bumpers are pre-filled on their next visit
 */

const CENTER_CODE_TO_QAMF_ID: Record<string, number> = {
  TXBSQN0FEKQ11: 9172,
  PPTR5G2N0QXF7: 3148,
};

// ── GET ──────────────────────────────────────────────────────────────────────

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: idStr } = await ctx.params;
  const id = parseInt(idStr, 10);
  if (isNaN(id) || id < 1) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }

  try {
    let { players, shoePairsAllowed } = await getReservationPlayersWithShoeAllowance(id);

    // Bootstrap: if no player rows exist (reservation pre-dates this feature),
    // create placeholder rows from the reservation's player_count so the
    // confirmation-page form always has something to render.
    if (players.length === 0) {
      const reservation = await getBowlingReservation(id);
      if (reservation && (reservation.playerCount ?? 0) > 0) {
        await insertReservationPlayers(
          id,
          Array.from({ length: reservation.playerCount! }, (_, i) => ({
            slot: i + 1,
            name: `Bowler ${i + 1}`,
          })),
        );
        ({ players, shoePairsAllowed } = await getReservationPlayersWithShoeAllowance(id));
      }
    }

    return NextResponse.json({ players, shoePairsAllowed });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

// ── PATCH ─────────────────────────────────────────────────────────────────────

interface PlayerPatch {
  slot: number;
  name?: string | null;
  shoeSize?: string | null;
  bumpers?: boolean | null;
}

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: idStr } = await ctx.params;
  const id = parseInt(idStr, 10);
  if (isNaN(id) || id < 1) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }

  let body: { players: PlayerPatch[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const patches = body.players ?? [];
  if (!Array.isArray(patches) || patches.length === 0) {
    return NextResponse.json({ error: "players array required" }, { status: 400 });
  }

  // ── Load reservation (we need centerCode, qamfId, and current state) ──────
  const reservation = await getBowlingReservation(id);
  if (!reservation) {
    return NextResponse.json({ error: "reservation not found" }, { status: 404 });
  }

  // ── Validate shoe sizes ≤ shoe pairs purchased ────────────────────────────
  const { players: currentPlayers, shoePairsAllowed } =
    await getReservationPlayersWithShoeAllowance(id);

  // Merge patches into current state for count check
  const mergedShoeCount = currentPlayers.reduce((count, player) => {
    const patch = patches.find((p) => p.slot === player.slot);
    const effectiveSize = patch && "shoeSize" in patch ? patch.shoeSize : player.shoeSize;
    return effectiveSize ? count + 1 : count;
  }, 0);

  if (mergedShoeCount > shoePairsAllowed) {
    return NextResponse.json(
      {
        error: `You can only assign shoe sizes for ${shoePairsAllowed} bowler${
          shoePairsAllowed !== 1 ? "s" : ""
        } — that's how many pairs were purchased.`,
      },
      { status: 422 },
    );
  }

  // ── Save each patch to Neon ───────────────────────────────────────────────
  const saved = [];
  for (const patch of patches) {
    const row = await upsertReservationPlayer(id, patch.slot, {
      name: patch.name,
      shoeSize: patch.shoeSize,
      bumpers: patch.bumpers,
    });
    if (row) saved.push(row);
  }

  // ── Best-effort: call QAMF setLanePlayers ────────────────────────────────
  // Re-fetch updated players so QAMF gets the full merged list.
  if (reservation.qamfReservationId) {
    const qamfCenterId = CENTER_CODE_TO_QAMF_ID[reservation.centerCode];
    if (qamfCenterId) {
      const { players: updatedPlayers } = await getReservationPlayersWithShoeAllowance(id);
      const qamfPlayers = updatedPlayers
        .filter((p) => p.name)
        .map((p) => ({
          Name: p.name!,
          ShoeSize: p.shoeSize ?? undefined,
          ActivateBumpers: p.bumpers ?? false,
        }));

      if (qamfPlayers.length > 0) {
        // QAMF requires a laneId — for advance reservations the lane isn't
        // assigned yet. We pass "0" as a sentinel; some QAMF versions
        // accept it for pre-arrival player data. Non-fatal on any error.
        try {
          await setLanePlayers(
            qamfCenterId,
            reservation.qamfReservationId,
            "0",
            qamfPlayers,
          );
        } catch {
          // Non-fatal — player data is saved in Neon; staff can enter at desk
        }
      }
    }
  }

  // ── Write back KBF member prefs ──────────────────────────────────────────
  // For any KBF bowler (kbf_pass_id set), update shoe size + bumpers so
  // they're pre-filled on the member's next booking.
  for (const row of saved) {
    if (!row.kbfPassId || row.kbfMemberSlot == null || !row.kbfRelation) continue;
    const patch = patches.find((p) => p.slot === row.slot);
    if (!patch) continue;

    const shoeSizeLabel = row.shoeSize ?? null;
    const wantShoes = row.shoeSize != null ? true : null;

    try {
      await upsertMemberPref({
        passId: row.kbfPassId,
        memberSlot: row.kbfMemberSlot,
        relation: row.kbfRelation,
        shoeSizeLabel,
        wantShoes,
        wantBumpers: row.bumpers ?? null,
      });
    } catch {
      // Non-fatal — prefs are a convenience, not required
    }
  }

  return NextResponse.json({ players: saved, shoePairsAllowed });
}
