/**
 * Never hand out a lane somebody is standing on.
 *
 * THIS IS NOT LANE ARRANGEMENT. Arrangement decides which free lane is BEST — an
 * optimisation, piloted at one centre behind its own switch. This decides whether a lane
 * is usable AT ALL, which is correctness, applies to every centre, and is on for everyone.
 * Keeping them separate is the point: turning the pilot off must never turn this off.
 *
 * The gap it closes: for a booking starting right now, QAMF auto-assigns off the SCHEDULE
 * and fills from the lowest lane number up. The schedule says a lane is free the moment its
 * booked window ends — but the previous group is often still on it, and the physical lane
 * read is a separate call QAMF never consults. That is how a kiosk walk-up was handed
 * FastTrax lane 1 on 2026-08-31 while lane 1 was still running, with seven lanes free.
 *
 * The vendor already protects the other half. QAMF refuses to double-book its own schedule
 * (409 "Not enough resources available", proven live 2026-08-25), so the ONLY thing it gets
 * wrong is the floor. Excluding physically-occupied lanes is therefore the whole fix, not a
 * heuristic — which is why this can be a small always-on guard rather than a second engine.
 *
 * `openLanesFrom` — `Status === "Closed"` means free to start now — is the same predicate
 * the per-lane QR flow and self-service check-in already trust. It simply was never applied
 * on the ordinary hold path.
 *
 * ONE THING IS SHARED with the arrangement engine, deliberately: `wholePairSets`, which
 * decides what a legal multi-lane set even is. This file used to keep its own copy on the
 * grounds that a correctness guard must not depend on a pilot — but the rule it encodes is
 * the VENDOR's (a non-adjacent `Lanes` array is a 400) plus the owner's pairing rule, not
 * the engine's opinion, and two copies of it is precisely how the 2026-09-04 refusals got
 * shipped. It is a pure function over lane numbers with no flag behind it.
 */
import { listLanes } from "@/lib/qamf-bowling";
import { wholePairSets } from "~/features/lane-plan/grid";
import { openLanesFrom } from "./bowl-now";
import { bowlingLaneCount } from "./bowling-offer";

/**
 * How close to the start counts as "buying now".
 *
 * Inside this window the guest walks straight to the lane, so the floor read taken at
 * booking time is still true when they get there. Beyond it the board has time to turn
 * over and a snapshot would be worse than no opinion — that horizon is the re-check's job.
 */
export const IMMEDIATE_START_WINDOW_MINUTES = 20;

/** Ranked lane sets offered to the vendor before giving up and letting it choose. */
export const MAX_GUARD_CANDIDATES = 3;

/**
 * Emergency off switch, ON by default like every other flag here. Its own variable, NOT
 * `LANE_ARRANGEMENT` — killing the arrangement pilot must not also stop us checking whether
 * a lane is occupied.
 */
export function immediateLaneGuardEnabled(): boolean {
  return process.env.IMMEDIATE_LANE_GUARD !== "false";
}

/** Is this booking starting now-ish, i.e. is the guest about to walk to the lane? */
export function isImmediateStart(bookedAtMs: number, nowMs: number): boolean {
  if (!Number.isFinite(bookedAtMs)) return false;
  const deltaMs = bookedAtMs - nowMs;
  // Slightly in the past is normal: kiosk walk-ups floor BookedAt to a 5-minute boundary.
  return deltaMs <= IMMEDIATE_START_WINDOW_MINUTES * 60_000 && deltaMs >= -30 * 60_000;
}

/**
 * Lane sets for this party drawn ONLY from lanes that are physically free right now.
 *
 * Ascending, matching the vendor's own preference, so a centre with no arrangement pilot
 * changes as little as possible: same lane it would have picked, unless that lane is
 * occupied. Never throws — an empty list means "no opinion", and the caller then books
 * exactly as it always did.
 */
export interface FreeLaneChoice {
  /** Ranked lane sets we are willing to ask for. Empty means "no opinion". */
  candidates: number[][];
  /** Every lane the floor said was free when we looked — the evidence behind the choice,
   *  and the thing you need to answer "why that lane?" a day later. */
  freeLanes: number[];
}

export async function freeLaneCandidates(opts: {
  centerId: number;
  players: number;
  /** Ranked lane sets from the arrangement engine, if this centre is piloted. */
  preferred?: number[][];
  /**
   * Lanes this product may be sold on. `null` = no restriction.
   *
   * WITHOUT THIS THE FALLBACK IS SECTION-BLIND: free lanes ascending starts at lane 1, which
   * at Fort Myers is Old Time, so a Regular booking was offered 1, 2 and 3 — three
   * guaranteed `lanes_not_compatible` refusals before falling open. Measured in production
   * 2026-09-02: 18 such refusals in a day.
   */
  allowedLanes?: number[] | null;
}): Promise<FreeLaneChoice> {
  try {
    const lanes = await listLanes(opts.centerId);
    const sellable = opts.allowedLanes?.length ? new Set(opts.allowedLanes) : null;
    const free = openLanesFrom(lanes).filter((l) => !sellable || sellable.has(l));
    if (free.length === 0) return { candidates: [], freeLanes: [] };
    const freeSet = new Set(free);

    // With a plan, keep its ORDER and drop anything the floor says is occupied — the two
    // reads happen moments apart and can disagree.
    if (opts.preferred?.length) {
      const kept = opts.preferred.filter((set) => set.every((n) => freeSet.has(n)));
      if (kept.length) return { candidates: kept.slice(0, MAX_GUARD_CANDIDATES), freeLanes: free };
    }

    return {
      candidates: wholePairSets(free, bowlingLaneCount(opts.players)).slice(
        0,
        MAX_GUARD_CANDIDATES,
      ),
      freeLanes: free,
    };
  } catch (err) {
    // A lane preference must never cost a booking. If we cannot read the floor we simply
    // do not have an opinion, and the vendor assigns as it always has.
    console.warn("[immediate-lane-guard] floor read failed (vendor will choose):", err);
    return { candidates: [], freeLanes: [] };
  }
}
