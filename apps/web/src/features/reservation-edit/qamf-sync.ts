/**
 * QAMF (Conqueror) sync for reservation edits.
 *
 * QAMF has NO player-count / lane-count / time mutation API (probed live
 * 2026-07-10; patchReservation mutates Title/Notes/Status only), so:
 *   - player-only changes are a TRUE PATCH: PUT each lane's player list
 *     (setLanePlayers) + re-PATCH the Title (Title is REQUIRED in the body —
 *     a Notes-only PATCH 400s) with the new "(Np)" count;
 *   - lane-count changes REBOOK: availability-check the same bookedAt for the
 *     new TotalPlayers (fatal guard — never charge for lanes we can't get),
 *     then delete→verify→create→confirm via rescheduleQamfReservation.
 */

import {
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
 * Push the desired roster to every lane on the reservation and refresh the
 * Title's player count. Players are distributed across lanes round-robin in
 * slot order (matching the wizard's fill order); Conqueror staff re-seat on
 * the desk as needed — the roster NAMES are what matter.
 */
export const syncQamfPlayers = async (params: {
  qamfCenterId: number;
  qamfReservationId: string;
  players: QamfPlayerInput[];
  guestName: string;
}): Promise<{ lanesUpdated: number }> => {
  const live = await getReservation(params.qamfCenterId, params.qamfReservationId);
  const lanes = live.Lanes ?? [];
  if (lanes.length === 0) return { lanesUpdated: 0 };

  const perLane = Math.ceil(params.players.length / lanes.length);
  let updated = 0;
  for (let i = 0; i < lanes.length; i++) {
    const lane = lanes[i] as { Id?: string; LaneNumber?: number };
    const laneId = lane.Id ?? String(lane.LaneNumber ?? "");
    if (!laneId) continue;
    const slice = params.players.slice(i * perLane, (i + 1) * perLane);
    await setLanePlayers(
      params.qamfCenterId,
      params.qamfReservationId,
      laneId,
      slice.map((p) => ({
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
    Title: `${baseTitle} (${params.players.length}p)`,
    ...(live.Notes ? { Notes: live.Notes } : {}),
  });

  return { lanesUpdated: updated };
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
