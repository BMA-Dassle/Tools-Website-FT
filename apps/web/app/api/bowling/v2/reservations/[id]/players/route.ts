import { NextRequest, NextResponse } from "next/server";
import {
  getBowlingReservation,
  getReservationPlayersWithShoeAllowance,
  insertReservationPlayers,
  upsertReservationPlayer,
} from "@/lib/bowling-db";
import { upsertMemberPref, getPrefsForPlayers } from "@/lib/kbf-prefs";
import { getReservation, setLanePlayers } from "@/lib/qamf-bowling";
import { CENTER_CODE_TO_QAMF_ID } from "@/lib/qamf-centers";
import { syncShoeKdsLineItems } from "@/lib/bowling-shoe-kds";

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
 *   2. Syncs $0 shoe-size line items to the Square day-of order so the KDS
 *      shows each bowler's shoe size + name when the order is paid out
 *   3. Writes KBF member prefs back for any player with a kbf_pass_id
 *      so shoe size + bumpers are pre-filled on their next visit
 */

// center_code → QAMF id (incl. FastTrax duckpin 11542) — shared registry.

// ── GET ──────────────────────────────────────────────────────────────────────

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
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

    // ── Backfill shoe sizes + bumpers from KBF prefs ──────────────
    // KBF reservations insert players with null shoe sizes (the wizard
    // doesn't collect them). If the member has prefs from a previous
    // visit, inject them so the confirmation page shows them pre-filled.
    const kbfPlayersNeedingPrefs = players.filter(
      (p) => p.kbfPassId != null && p.kbfMemberSlot != null && !p.shoeSize,
    );
    if (kbfPlayersNeedingPrefs.length > 0) {
      const prefsMap = await getPrefsForPlayers(
        kbfPlayersNeedingPrefs.map((p) => ({
          passId: p.kbfPassId!,
          memberSlot: p.kbfMemberSlot!,
        })),
      );
      for (const p of kbfPlayersNeedingPrefs) {
        const pref = prefsMap.get(`${p.kbfPassId}|${p.kbfMemberSlot}`);
        if (pref?.shoeSizeLabel) {
          p.shoeSize = pref.shoeSizeLabel;
        }
        if (pref?.wantBumpers != null && p.bumpers == null) {
          p.bumpers = pref.wantBumpers;
        }
      }
    }

    const laneNumbers = [
      ...new Set(players.map((p) => p.laneNumber).filter((n): n is number => n != null)),
    ].sort((a, b) => a - b);
    return NextResponse.json({ players, shoePairsAllowed, laneNumbers });
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
  laneNumber?: number | null;
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
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

  // ── Block modifications after lanes are open ──────────────────────────────
  if (reservation.dayofOrderLane) {
    return NextResponse.json(
      { error: "Shoes cannot be changed after lanes have been opened." },
      { status: 409 },
    );
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
        } — that's how many are included with this booking.`,
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
      laneNumber: patch.laneNumber,
    });
    if (row) saved.push(row);
  }

  // ── Best-effort: call QAMF setLanePlayers ────────────────────────────────
  // Re-fetch updated players so QAMF gets the full merged list.
  // Group by stored laneNumber so the customer's lane assignment is honoured.
  if (reservation.qamfReservationId) {
    const qamfCenterId = CENTER_CODE_TO_QAMF_ID[reservation.centerCode];
    if (qamfCenterId) {
      const { players: updatedPlayers } = await getReservationPlayersWithShoeAllowance(id);

      // Group players by lane number
      const byLane = new Map<number, typeof updatedPlayers>();
      for (const p of updatedPlayers) {
        if (!p.name) continue;
        const ln = p.laneNumber ?? 0;
        const arr = byLane.get(ln) ?? [];
        arr.push(p);
        byLane.set(ln, arr);
      }

      if (byLane.size > 0) {
        try {
          const qamfRes = await getReservation(qamfCenterId, reservation.qamfReservationId);
          const lanes = qamfRes.Lanes ?? [];
          await Promise.all(
            [...byLane.entries()].map(([laneNum, lanePlayerList]) => {
              const lane = lanes.find((l) => l.LaneNumber === laneNum) ?? lanes[0];
              if (!lane) return Promise.resolve();
              return setLanePlayers(
                qamfCenterId,
                reservation.qamfReservationId!,
                lane.Id,
                lanePlayerList.map((p) => ({
                  Name: p.name!,
                  ShoeSize: p.shoeSize ?? undefined,
                  ActivateBumpers: p.bumpers ?? false,
                })),
              );
            }),
          );
        } catch {
          // Non-fatal — player data is saved in Neon; staff can enter at desk
        }
      }
    }
  }

  // ── Best-effort: sync shoe-size KDS items to Square day-of order ──
  // Each player with a shoe size gets a $0 line item on the day-of order
  // so the KDS shows shoe sizes + bowler names when the order is paid out.
  if (reservation.squareDayofOrderId) {
    const { players: latestPlayers } = await getReservationPlayersWithShoeAllowance(id);
    await syncShoeKdsLineItems({
      orderId: reservation.squareDayofOrderId,
      players: latestPlayers.map((p) => ({ name: p.name, shoeSize: p.shoeSize })),
      idempotencyKey: `shoe-kds-${id}-${Date.now()}`,
      logLabel: "players",
    });
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

  return NextResponse.json({
    players: saved,
    shoePairsAllowed,
    laneNumbers: [
      ...new Set(saved.map((p) => p.laneNumber).filter((n): n is number => n != null)),
    ].sort((a, b) => a - b),
  });
}
