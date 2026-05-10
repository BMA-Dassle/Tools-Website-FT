import { NextRequest, NextResponse } from "next/server";
import {
  getBowlingReservation,
  getReservationPlayersWithShoeAllowance,
  insertReservationPlayers,
  upsertReservationPlayer,
} from "@/lib/bowling-db";
import { upsertMemberPref } from "@/lib/kbf-prefs";
import { getReservation, setLanePlayers } from "@/lib/qamf-bowling";

// ── Square helpers (shoe-size KDS sync) ─────────────────────────────
const SQUARE_BASE    = "https://connect.squareup.com/v2";
const SQUARE_VERSION = "2024-12-18";
/** $0 catalog item used as a KDS ticket for shoe sizes. */
const SHOE_KDS_CATALOG_ID = "M4UJZDGXBWMGBSAFZPW3ZP6G";

function sqHeaders(): Record<string, string> {
  return {
    Authorization:    `Bearer ${process.env.SQUARE_ACCESS_TOKEN ?? ""}`,
    "Content-Type":   "application/json",
    "Square-Version": SQUARE_VERSION,
  };
}

/** "Women 8" → "Women's Size 8", "Men 11" → "Men's Size 11", etc. */
function formatShoeSize(raw: string): string {
  const spaceIdx = raw.indexOf(" ");
  if (spaceIdx === -1) return raw;
  const category = raw.slice(0, spaceIdx).toLowerCase();
  const size = raw.slice(spaceIdx + 1);
  if (category === "women") return `Women's Size ${size}`;
  if (category === "men")   return `Men's Size ${size}`;
  if (category === "kids")  return `Kids' Size ${size}`;
  return `${raw.slice(0, spaceIdx)} Size ${size}`;
}

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

    const laneNumbers = [...new Set(players.map((p) => p.laneNumber).filter((n): n is number => n != null))].sort((a, b) => a - b);
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
    try {
      const { players: latestPlayers } = await getReservationPlayersWithShoeAllowance(id);
      const shoePlayers = latestPlayers.filter((p) => p.shoeSize);

      const sqOrderRes = await fetch(
        `${SQUARE_BASE}/orders/${reservation.squareDayofOrderId}`,
        { headers: sqHeaders(), cache: "no-store" },
      );
      if (sqOrderRes.ok) {
        const sqOrderJson = await sqOrderRes.json() as {
          order?: {
            id: string; version: number; location_id: string; state: string;
            line_items?: Array<{ uid: string; catalog_object_id?: string }>;
          };
        };
        const sqOrder = sqOrderJson.order;
        if (sqOrder && sqOrder.state !== "CANCELED" && sqOrder.state !== "COMPLETED") {
          // Remove existing shoe-size KDS items, then add current set
          const existingShoeUids = (sqOrder.line_items ?? [])
            .filter((li) => li.catalog_object_id === SHOE_KDS_CATALOG_ID)
            .map((li) => li.uid);
          const fieldsToClear = existingShoeUids.map(
            (uid) => `order.line_items[${uid}]`,
          );
          const newShoeItems = shoePlayers.map((p) => ({
            catalog_object_id: SHOE_KDS_CATALOG_ID,
            quantity: "1",
            name: formatShoeSize(p.shoeSize!),
            note: p.name || undefined,
            base_price_money: { amount: 0, currency: "USD" },
          }));

          if (fieldsToClear.length > 0 || newShoeItems.length > 0) {
            const updateRes = await fetch(
              `${SQUARE_BASE}/orders/${reservation.squareDayofOrderId}`,
              {
                method: "PUT",
                headers: sqHeaders(),
                body: JSON.stringify({
                  order: {
                    version: sqOrder.version,
                    location_id: reservation.centerCode,
                    ...(newShoeItems.length > 0 ? { line_items: newShoeItems } : {}),
                  },
                  ...(fieldsToClear.length > 0 ? { fields_to_clear: fieldsToClear } : {}),
                  idempotency_key: `shoe-kds-${id}-${Date.now()}`,
                }),
              },
            );
            if (!updateRes.ok) {
              const errBody = await updateRes.json().catch(() => ({})) as {
                errors?: Array<{ detail?: string }>;
              };
              console.warn(
                `[players] shoe KDS sync failed for neonId=${id}:`,
                errBody.errors?.[0]?.detail ?? updateRes.status,
              );
            }
          }
        }
      }
    } catch (err) {
      // Non-fatal — shoe KDS items are a convenience for kitchen staff
      console.warn(`[players] shoe KDS sync error for neonId=${id}:`, err instanceof Error ? err.message : err);
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

  return NextResponse.json({ players: saved, shoePairsAllowed, laneNumbers: [...new Set(saved.map((p) => p.laneNumber).filter((n): n is number => n != null))].sort((a, b) => a - b) });
}
