"use client";

/**
 * Cart-free race availability for the kiosk Race Info hub's VIEW-ONLY grid
 * (owner 2026-07-21). Answers "what races are running today and which could a
 * walk-up guest book?" without a booking session:
 *
 *   - Fetches TODAY's availability for every single-race product on the
 *     schedule's track(s) — same query keys as the booking grids, so React
 *     Query dedupes against an in-flight wizard on the same device.
 *   - Every tier renders the same (owner 2026-07-21: Inter/Pro must NOT read
 *     "returning only" — they look just like Starter). A heat greys out only
 *     when the BOOKING RULES say it isn't bookable right now: starting too
 *     soon (kiosk lead-time floors), full, or restriction-engine blocked.
 *   - Rule context per tier: Starter assumes a NEW racer (15-min lead, not
 *     express-eligible); Intermediate/Pro assume a RETURNING qualified racer
 *     (10-min lead, express-eligible) — "assume inter and pro is returning
 *     following those rules".
 *
 * Read-only: no holds, no session writes — display truth only. The booking
 * wizard remains the sole authority for actual bookability at purchase time.
 */
import { useMemo, useState } from "react";
import { useQueries } from "@tanstack/react-query";
import { bookingKeys, RACE_AVAILABILITY_POLL_MS } from "~/features/booking";
import { bmiAdapter, type BmiAvailabilityResponse } from "~/features/booking/data";
import { scheduleForDate, type Schedule } from "~/features/booking/service/race-pricing";
import {
  singleRaceProductsOnTrack,
  type RaceCategory,
  type RaceTier,
} from "~/features/booking/service/race-products";
import {
  evaluateRaceRestrictions,
  type RestrictionBlock,
  type TrackTierBlock,
} from "~/features/booking/service/race-restriction-rules";

export type DisplayTrack = "Red" | "Blue" | "Mega";

export type HeatDisplayStatus =
  | "open" // bookable now
  | "low" // bookable, ≤30% spots left
  | "full" // no spots left
  | "restricted" // blocked by a restriction rule (greyed w/ the rule's label)
  | "too-soon"; // starts inside the kiosk lead-time floor (greyed)

export interface DisplayHeat {
  key: string;
  track: DisplayTrack;
  tier: RaceTier;
  category: RaceCategory;
  /** Naive center-local ISO from BMI (e.g. "2026-07-21T18:15:00"). */
  startLocal: string;
  startMs: number;
  /** "6:15 PM" */
  timeLabel: string;
  freeSpots: number;
  capacity: number;
  status: HeatDisplayStatus;
  /** Label for greyed cards ("Returning drivers only", rule cardLabel, "Full"). */
  statusLabel?: string;
}

// The kiosk booking grid's lead-time floors (RaceHeatPickerStep
// KIOSK_NEW_RACER_LEAD_MINUTES / KIOSK_RETURNING_LEAD_MINUTES). Heats inside
// the floor GREY OUT here rather than disappear (owner 2026-07-21: "greying
// out starter thats in 10 minutes following our booking rules") — Starter
// assumes a new racer (15), Inter/Pro assume returning (10).
const NEW_RACER_LEAD_MINUTES = 15;
const RETURNING_LEAD_MINUTES = 10;

function parseLocalMs(iso: string): number {
  return new Date(iso.replace(/Z$/, "")).getTime();
}

function timeLabel(iso: string): string {
  return new Date(iso.replace(/Z$/, "")).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

/** Today's date (center-local, America/New_York) as YYYY-MM-DD. */
function centerToday(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

export function useRaceGridDisplay(center: string): {
  heats: DisplayHeat[];
  tracks: DisplayTrack[];
  schedule: Schedule;
  isLoading: boolean;
  isError: boolean;
} {
  // Pinned per mount — the attract loop resets the kiosk between guests, so a
  // midnight rollover mid-view isn't worth a live clock subscription.
  const [date] = useState(centerToday);
  const schedule = useMemo(() => scheduleForDate(date), [date]);
  const tracks = useMemo<DisplayTrack[]>(
    () => (schedule === "mega" ? ["Mega"] : ["Red", "Blue"]),
    [schedule],
  );

  // Every single-race product on today's track(s), all tiers + categories.
  // racerType "existing" carries the full tier range (new = starter only);
  // both variants expose the same underlying sessions.
  const fetches = useMemo(
    () =>
      tracks.flatMap((track) =>
        singleRaceProductsOnTrack(track, schedule, "existing").map((p) => ({
          productId: p.productId,
          pageId: p.pageId,
          track,
          tier: p.tier,
          category: p.category,
        })),
      ),
    // `tracks` is memoized on schedule, so its reference is stable per day.
    [tracks, schedule],
  );

  const queries = useQueries({
    queries: fetches.map(({ productId, pageId }) => ({
      queryKey: bookingKeys.bmi.availability({ center, date, productId }),
      queryFn: (): Promise<BmiAvailabilityResponse> =>
        bmiAdapter.getAvailability({ date, productId, pageId, quantity: 1 }),
      staleTime: 60_000,
      // Semi-live like the booking grids — the info screen sits open on the
      // attract loop and must track other guests' bookings.
      refetchInterval: RACE_AVAILABILITY_POLL_MS,
      refetchIntervalInBackground: false,
    })),
  });

  const isLoading = queries.some((q) => q.isLoading);
  const isError = queries.length > 0 && queries.every((q) => q.isError);

  const heats = useMemo<DisplayHeat[]>(() => {
    const nowMs = Date.now();

    // Per-product raw blocks, indexed alongside `fetches`.
    const perProduct: RestrictionBlock[][] = queries.map((q) => {
      const blocks: RestrictionBlock[] = [];
      for (const p of q.data?.proposals ?? []) {
        const b = p.blocks?.[0]?.block;
        if (!b) continue;
        blocks.push({
          startMs: parseLocalMs(b.start),
          freeSpots: b.freeSpots,
          capacity: b.capacity,
        });
      }
      return blocks;
    });

    // Cross-tier unions per track — the same occupancy signals the wizard's
    // restriction rules read (see useCrossTierBlocks).
    const allByTrack = new Map<string, TrackTierBlock[]>();
    const categoryByTrack = new Map<string, RestrictionBlock[]>();
    fetches.forEach((src, i) => {
      for (const rb of perProduct[i]) {
        const all = allByTrack.get(src.track) ?? [];
        all.push({ ...rb, adultStarter: src.tier === "starter" && src.category === "adult" });
        allByTrack.set(src.track, all);
        const catKey = `${src.track}:${src.category}`;
        const cat = categoryByTrack.get(catKey) ?? [];
        cat.push(rb);
        categoryByTrack.set(catKey, cat);
      }
    });

    const out: DisplayHeat[] = [];
    fetches.forEach((src, i) => {
      const q = queries[i];
      const leadMinutes = src.tier === "starter" ? NEW_RACER_LEAD_MINUTES : RETURNING_LEAD_MINUTES;
      const leadCutoffMs = nowMs + leadMinutes * 60_000;
      for (const p of q.data?.proposals ?? []) {
        const b = p.blocks?.[0]?.block;
        if (!b) continue;
        const startMs = parseLocalMs(b.start);
        if (startMs < nowMs) continue; // already started — off the board

        const base = {
          key: `${src.track}:${src.tier}:${src.category}:${b.start}`,
          track: src.track,
          tier: src.tier,
          category: src.category,
          startLocal: b.start,
          startMs,
          timeLabel: timeLabel(b.start),
          freeSpots: b.freeSpots,
          capacity: b.capacity,
        };

        if (b.freeSpots === 0) {
          out.push({ ...base, status: "full", statusLabel: "Full" });
          continue;
        }

        // The real rule engine, per-tier context: Starter = new racer (never
        // express-eligible, so opening-window heats grey with the rule's own
        // label); Inter/Pro = returning qualified racer with a valid waiver.
        const verdict = evaluateRaceRestrictions({
          tier: src.tier,
          category: src.category,
          track: src.track,
          candidateStartMs: startMs,
          candidateStartLocal: b.start,
          nowMs,
          productBlocks: perProduct[i],
          categoryTrackBlocks: categoryByTrack.get(`${src.track}:${src.category}`),
          trackAllTierBlocks: allByTrack.get(src.track),
          expressEligible: src.tier !== "starter",
          kiosk: true,
        });
        if (verdict.blocked) {
          if (verdict.action === "hide") continue;
          out.push({
            ...base,
            status: "restricted",
            statusLabel: verdict.cardLabel ?? "Unavailable",
          });
          continue;
        }

        // Inside the kiosk lead-time floor → greyed, not hidden.
        if (startMs < leadCutoffMs) {
          out.push({ ...base, status: "too-soon", statusLabel: "Starting soon" });
          continue;
        }

        out.push({
          ...base,
          status: b.freeSpots / b.capacity <= 0.3 ? "low" : "open",
        });
      }
    });

    out.sort((a, b) => a.startMs - b.startMs || a.track.localeCompare(b.track));
    return out;
  }, [queries, fetches]);

  return { heats, tracks, schedule, isLoading, isError };
}
