/**
 * QAMF (Conqueror) sync for reservation edits.
 *
 * Player-count semantics (bowling-reservations v1.2 spec, owner-supplied
 * 2026-07-11):
 *   - DECREASE: per-player DELETE removes specific players — valid on
 *     reservations that haven't happened yet (lanes un-opened; no check-in
 *     required). The lane-players PUT is SAME-COUNT-ONLY (live 409:
 *     "Requested updated players are 1, but actual players are 2"), so the
 *     deletes come first, then the PUT syncs names onto the surviving seats.
 *   - Names/shoes/bumpers: PUT each lane's player list (setLanePlayers) +
 *     re-PATCH the Title (Title is REQUIRED in the body — a Notes-only
 *     PATCH 400s) with the new "(Np)" count.
 *   - lane-count changes REBOOK: availability-check the same bookedAt for the
 *     new TotalPlayers (fatal guard — never charge for lanes we can't get),
 *     then delete→verify→create→confirm via rescheduleQamfReservation.
 */

import {
  deleteLanePlayer,
  getReservation,
  patchReservation,
  searchAvailability,
  setLanePlayers,
} from "@/lib/qamf-bowling";
import type { BowlingReservationPlayer } from "@/lib/bowling-db";
import {
  rescheduleQamfReservation,
  type QamfRescheduleOutcome,
} from "~/features/booking/service/qamf-reschedule";

import { EditGuardError } from "./types";

export interface QamfPlayerInput {
  name: string | null;
  shoeSize?: string | null;
  bumpers?: boolean | null;
}

/**
 * Push the desired roster to the reservation and refresh the Title's player
 * count. A DECREASE deletes the excess players first (per-player DELETE —
 * end of the lineup, last lane first; the PUT right after rewrites the
 * surviving seats' names, so which seats die doesn't matter), then every
 * lane receives EXACTLY as many entries as it holds (the PUT refuses count
 * changes). Valid while lanes are un-opened — i.e. reservations that
 * haven't happened yet, the PRE-phase edit window.
 */
export const syncQamfPlayers = async (params: {
  qamfCenterId: number;
  qamfReservationId: string;
  players: QamfPlayerInput[];
  guestName: string;
}): Promise<{ lanesUpdated: number; playersRemoved: number }> => {
  let live = await getReservation(params.qamfCenterId, params.qamfReservationId);
  let lanes = live.Lanes ?? [];
  if (lanes.length === 0) return { lanesUpdated: 0, playersRemoved: 0 };

  const desired = params.players.length;
  const liveTotal = lanes.reduce((s, l) => s + (l.Players?.length ?? 0), 0);

  // ── DECREASE: delete the excess players, then re-read live state ─────
  let playersRemoved = 0;
  if (liveTotal > desired) {
    let toRemove = liveTotal - desired;
    for (const lane of [...lanes].reverse()) {
      if (toRemove === 0) break;
      const laneId = lane.Id;
      if (!laneId) continue;
      const candidates = lane.Players ?? [];
      for (let i = candidates.length - 1; i >= 0 && toRemove > 0; i--) {
        const victim = candidates[i];
        if (victim.Id == null) continue; // not addressable — try another seat
        await deleteLanePlayer(params.qamfCenterId, params.qamfReservationId, laneId, victim.Id);
        playersRemoved++;
        toRemove--;
      }
    }
    if (toRemove > 0) {
      throw new Error(
        `QAMF player decrease incomplete — ${toRemove} player(s) had no addressable id`,
      );
    }
    // Fresh state: the roster PUT below must match the new per-lane counts.
    live = await getReservation(params.qamfCenterId, params.qamfReservationId);
    lanes = live.Lanes ?? [];
  }

  // ── Same-count roster PUT per lane (names/shoes/bumpers) ─────────────
  // Real roster names first (wizard fill order); "Bowler N" placeholders
  // fill any remaining seats.
  const fallbackPerLane = Math.max(1, Math.ceil(desired / Math.max(1, lanes.length)));
  let updated = 0;
  let next = 0; // index into the desired roster
  let seat = 0; // global seat counter for placeholder names
  for (const lane of lanes) {
    const laneId = lane.Id ?? String(lane.LaneNumber ?? "");
    if (!laneId) continue;
    const seatCount = Array.isArray(lane.Players) ? lane.Players.length : fallbackPerLane;
    if (seatCount === 0) continue;
    const assigned: QamfPlayerInput[] = [];
    for (let s = 0; s < seatCount; s++) {
      seat++;
      const p = params.players[next];
      if (p) {
        assigned.push(p);
        next++;
      } else {
        assigned.push({ name: `Bowler ${seat}` });
      }
    }
    await setLanePlayers(
      params.qamfCenterId,
      params.qamfReservationId,
      laneId,
      assigned.map((p) => ({
        Name: p.name?.trim() || "Bowler",
        ...(p.shoeSize ? { ShoeSize: p.shoeSize } : {}),
        ActivateBumpers: p.bumpers ?? false,
      })),
    );
    updated++;
  }

  // Title refresh — MUST resend Notes alongside (Title-only is fine; a
  // Notes-only PATCH 400s. We preserve the live Notes verbatim).
  const baseTitle = (live.Title ?? params.guestName).replace(/\s*\(\d+p\)\s*$/, "").trim();
  await patchReservation(params.qamfCenterId, params.qamfReservationId, {
    Title: `${baseTitle} (${desired}p)`,
    ...(live.Notes ? { Notes: live.Notes } : {}),
  });

  return { lanesUpdated: updated, playersRemoved };
};

/** Convert bowling_reservation_players rows to the QAMF roster shape. */
export const playersToQamfRoster = (
  players: Pick<BowlingReservationPlayer, "name" | "shoeSize" | "bumpers">[],
  targetCount: number,
): QamfPlayerInput[] => {
  const roster: QamfPlayerInput[] = players
    .slice(0, targetCount)
    .map((p) => ({ name: p.name, shoeSize: p.shoeSize, bumpers: p.bumpers }));
  while (roster.length < targetCount) {
    roster.push({ name: `Bowler ${roster.length + 1}` });
  }
  return roster;
};

/**
 * Lane-count change = rebook: verify availability at the SAME bookedAt for
 * the new player total (fatal — throws qamf_availability when the slot can't
 * fit), then delete→verify→create→confirm. PRE phase only (guards.ts refuses
 * mid-session lane changes).
 */
export const rebookQamfForLaneChange = async (params: {
  neonId: number;
  qamfCenterId: number;
  qamfReservationId: string;
  bookedAt: string;
  webOfferId: number;
  optionId?: number;
  optionType?: "Game" | "Time" | "Unlimited";
  newPlayerCount: number;
  existing: {
    guestName?: string;
    guestPhone?: string;
    guestEmail?: string;
    notes?: string;
    comboSpecialId?: string;
  };
}): Promise<{ newQamfId: string }> => {
  // Availability guard for the grown party at the same slot. QAMF probe times
  // must sit on 5-minute boundaries — bookedAt comes from the reservation, so
  // it already does.
  try {
    const avail = await searchAvailability(params.qamfCenterId, {
      BookedAtRange: { StartAt: params.bookedAt, EndAt: params.bookedAt },
      TotalPlayers: params.newPlayerCount,
      WebOffer: { Id: params.webOfferId, Services: ["BookForLater"] },
    });
    const slots = avail.Availabilities ?? [];
    if (slots.length === 0 || !slots.some((s) => s.BookedAt === params.bookedAt)) {
      throw new EditGuardError(
        "qamf_availability",
        `no availability for ${params.newPlayerCount} players at ${params.bookedAt}`,
      );
    }
  } catch (e) {
    if (e instanceof EditGuardError) throw e;
    throw new EditGuardError(
      "qamf_availability",
      `availability check failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  const outcome: QamfRescheduleOutcome = await rescheduleQamfReservation({
    neonId: params.neonId,
    qamfCenterId: params.qamfCenterId,
    existing: {
      qamfReservationId: params.qamfReservationId,
      guestName: params.existing.guestName,
      guestPhone: params.existing.guestPhone,
      guestEmail: params.existing.guestEmail,
      notes: params.existing.notes,
      playerCount: params.newPlayerCount,
      comboSpecialId: params.existing.comboSpecialId,
    },
    bookedAt: params.bookedAt,
    webOfferId: params.webOfferId,
    optionId: params.optionId,
    optionType: params.optionType,
    logTag: "[reservation-edit/qamf]",
  });
  if (!outcome.ok) {
    throw new EditGuardError("qamf_availability", `QAMF rebook failed: ${outcome.error}`);
  }
  return { newQamfId: outcome.newQamfId };
};
