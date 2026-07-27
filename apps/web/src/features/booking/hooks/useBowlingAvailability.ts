"use client";

/**
 * React Query hooks for the v3 bowling flow (Experience + Time steps).
 * QueryProvider wraps /book/*\/v2 and /kiosk, so these are safe in any
 * bowling step. All availability queries run in optionCheck=accurate mode —
 * the whole point of the v3 flow is that displayed slots/durations are real.
 */

import { useQuery } from "@tanstack/react-query";
import type { BowlingExperienceWithDetails } from "@/lib/bowling-db";
import { getPublicReopenMinutes } from "@/lib/group-events";
import {
  fetchJsonWithRetry,
  parseAvailabilities,
  etMinutesOfDay,
  type AvailabilitySlot,
  type RawAvailability,
} from "~/components/features/booking/steps/bowling/availability-client";

/** Experiences for a center (unfiltered — callers apply kind/dow/world-cup
 *  rules). Cached 5 min; the catalog changes rarely. */
export function useBowlingExperiences(centerCode: string | null, kbf: boolean) {
  return useQuery({
    queryKey: ["bowling-v3", "experiences", centerCode, kbf],
    enabled: !!centerCode,
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const kindParam = kbf ? "&kind=kbf" : "";
      // Pinboyz seam: include the inactive pinboyz-* experiences
      // (is_active=false) so v3 surfaces can book Old Time Lanes.
      const data = await fetchJsonWithRetry<BowlingExperienceWithDetails[]>(
        `/api/bowling/v2/experiences?centerCode=${centerCode}${kindParam}&preview=pinboyz`,
      );
      return Array.isArray(data) ? data : [];
    },
  });
}

function dropBeforeReopen(slots: AvailabilitySlot[], date: string | null): AvailabilitySlot[] {
  const reopenMins = date ? getPublicReopenMinutes(date) : null;
  return reopenMins == null ? slots : slots.filter((s) => etMinutesOfDay(s.bookedAt) >= reopenMins);
}

export interface DayAvailabilityInput {
  centerId: number | null;
  date: string | null;
  players: number;
  /** "kbf" or "open,hourly" — same values the classic steps pass. */
  kind: string;
  leadMinutes: number;
  enabled?: boolean;
}

/**
 * One shared accurate full-day scan (30-min grid) for the Experience step's
 * per-card "Next lane at …" hints and duration-chip gating. A single QAMF
 * fan-out serves every card — never one scan per card.
 */
export function useDayAvailability(input: DayAvailabilityInput) {
  const { centerId, date, players, kind, leadMinutes } = input;
  return useQuery({
    queryKey: ["bowling-v3", "day-avail", centerId, date, players, kind, leadMinutes],
    enabled: (input.enabled ?? true) && centerId != null && !!date && players > 0,
    staleTime: 30_000,
    retry: false, // fetchJsonWithRetry handles the 502 cold-start backoff
    queryFn: async () => {
      // Pinboyz seam: &preview=pinboyz adds the inactive pinboyz-*
      // offers to the day scan so their cards get real "Next lane" hints.
      const raw = await fetchJsonWithRetry<RawAvailability>(
        `/api/bowling/v2/availability?centerId=${centerId}&players=${players}&startDate=${date}` +
          `&kind=${kind}&stepMinutes=30&leadMinutes=${leadMinutes}&optionCheck=accurate&preview=pinboyz`,
      );
      return dropBeforeReopen(parseAvailabilities(raw), date);
    },
  });
}

export interface OfferSlotsInput {
  centerId: number | null;
  date: string | null;
  players: number;
  kind: string;
  webOfferId: number | null;
  /** The picked duration — drives the per-slot tail-fit filter server-side. */
  durationMinutes: number | null;
  leadMinutes: number;
  enabled?: boolean;
}

/**
 * The Time step's full-day, per-offer, duration-accurate slot list (15-min
 * grid). Every slot returned is genuinely bookable for THIS offer at THIS
 * duration — the grid needs no second validation pass.
 */
export function useOfferSlots(input: OfferSlotsInput) {
  const { centerId, date, players, kind, webOfferId, durationMinutes, leadMinutes } = input;
  return useQuery({
    queryKey: [
      "bowling-v3",
      "offer-slots",
      centerId,
      date,
      players,
      webOfferId,
      durationMinutes,
      leadMinutes,
    ],
    enabled: (input.enabled ?? true) && centerId != null && !!date && webOfferId != null,
    staleTime: 30_000,
    retry: false,
    queryFn: async () => {
      const durParam = durationMinutes ? `&durationMinutes=${durationMinutes}` : "";
      // Pinboyz seam: &preview=pinboyz keeps the Time step's per-offer
      // grid working for the inactive pinboyz-* offer (176).
      const raw = await fetchJsonWithRetry<RawAvailability>(
        `/api/bowling/v2/availability?centerId=${centerId}&players=${players}&startDate=${date}` +
          `&kind=${kind}&webOfferId=${webOfferId}${durParam}&stepMinutes=15` +
          `&leadMinutes=${leadMinutes}&optionCheck=accurate&preview=pinboyz`,
      );
      return dropBeforeReopen(
        parseAvailabilities(raw).filter((s) => s.webOfferId === webOfferId),
        date,
      );
    },
  });
}
