"use client";

import { useMemo } from "react";
import { useQueries } from "@tanstack/react-query";
import { bookingKeys, RACE_AVAILABILITY_POLL_MS } from "~/features/booking";
import { bmiAdapter, type BmiAvailabilityResponse } from "~/features/booking/data";
import type { Schedule } from "~/features/booking/service/race-pricing";
import {
  singleRaceProductsOnTrack,
  type RaceCategory,
  type RacerType,
} from "~/features/booking/service/race-products";
import type {
  RestrictionBlock,
  TrackTierBlock,
} from "~/features/booking/service/race-restriction-rules";

/**
 * Cross-tier occupancy fan-out shared by the heat-picker grids
 * (RaceHeatPickerStep + PackageHeatPicker). An occupied heat is
 * tier-EXCLUSIVE in BMI availability, so the restriction rules that see past
 * a candidate's own tier (junior back-to-back + two-per-hour, the
 * adult-Starter room reserve) need the union of EVERY single-race product's
 * availability on the grid's track(s). Query keys match the grids' own
 * availability fetches, so React Query dedupes the candidate product's fetch.
 *
 * `failedTracks` lists tracks where ANY member query errored. Callers must
 * pass `undefined` unions for those tracks: a PARTIAL all-tier union
 * UNDERCOUNTS Starter room (occupied Starter sessions vanish from the hour)
 * and would false-block good slots — for a picker pre-filter the right
 * degradation is fail-open, with the server guard (assertHeatBookable)
 * staying authoritative.
 */
export function useCrossTierBlocks(args: {
  /** Tracks whose unions are needed. Empty array disables the fan-out. */
  tracks: Array<"Red" | "Blue" | "Mega">;
  schedule: Schedule;
  racerType: RacerType;
  date: string | null;
  center: string;
  quantity: number;
}): {
  allByTrack: Map<string, TrackTierBlock[]>;
  juniorByTrack: Map<string, RestrictionBlock[]>;
  failedTracks: Set<string>;
} {
  const { tracks, schedule, racerType, date, center, quantity } = args;

  const fetches = useMemo(
    () =>
      tracks.flatMap((track) =>
        singleRaceProductsOnTrack(track, schedule, racerType).map((p) => ({
          productId: p.productId,
          pageId: p.pageId,
          track: track as string,
          category: p.category as RaceCategory,
          adultStarter: p.tier === "starter" && p.category === "adult",
        })),
      ),
    // Serialize tracks so a same-content array from a fresh render doesn't refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tracks.join("|"), schedule, racerType],
  );

  const queries = useQueries({
    queries: fetches.map(({ productId, pageId }) => ({
      queryKey: bookingKeys.bmi.availability({ center, date: date ?? "", productId }),
      queryFn: (): Promise<BmiAvailabilityResponse> =>
        bmiAdapter.getAvailability({ date: date!, productId, pageId, quantity }),
      enabled: !!date && fetches.length > 0,
      staleTime: 60_000,
      // Semi-live: the occupancy unions the restriction rules read must track
      // other guests' bookings while the grid sits open (owner 2026-07-19).
      refetchInterval: RACE_AVAILABILITY_POLL_MS,
      refetchIntervalInBackground: false,
    })),
  });

  return useMemo(() => {
    const allByTrack = new Map<string, TrackTierBlock[]>();
    const juniorByTrack = new Map<string, RestrictionBlock[]>();
    const failedTracks = new Set<string>();
    queries.forEach((q, qi) => {
      const src = fetches[qi];
      if (!src) return;
      if (q.isError) {
        failedTracks.add(src.track);
        return;
      }
      if (!q.data?.proposals) return; // still loading — not a failure
      for (const p of q.data.proposals) {
        const b = p.blocks?.[0]?.block;
        if (!b) continue;
        const rb: RestrictionBlock = {
          startMs: new Date(b.start.replace(/Z$/, "")).getTime(),
          freeSpots: b.freeSpots,
          capacity: b.capacity,
        };
        const all = allByTrack.get(src.track) ?? [];
        all.push({ ...rb, adultStarter: src.adultStarter });
        allByTrack.set(src.track, all);
        if (src.category === "junior") {
          const jr = juniorByTrack.get(src.track) ?? [];
          jr.push(rb);
          juniorByTrack.set(src.track, jr);
        }
      }
    });
    return { allByTrack, juniorByTrack, failedTracks };
  }, [queries, fetches]);
}
