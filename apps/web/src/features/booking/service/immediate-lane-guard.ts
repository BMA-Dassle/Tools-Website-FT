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
 */
import { listLanes } from "@/lib/qamf-bowling";
import { openLanesFrom } from "./bowl-now";
import { bowlingLaneCount } from "./bowling-offer";
import { enumerateCandidates } from "~/features/lane-plan/policy";

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
export async function freeLaneCandidates(opts: {
  centerId: number;
  players: number;
  /** Ranked lane sets from the arrangement engine, if this centre is piloted. */
  preferred?: number[][];
}): Promise<number[][]> {
  try {
    const lanes = await listLanes(opts.centerId);
    const free = openLanesFrom(lanes);
    if (free.length === 0) return [];
    const freeSet = new Set(free);

    // With a plan, keep its ORDER and drop anything the floor says is occupied — the two
    // reads happen moments apart and can disagree.
    if (opts.preferred?.length) {
      const kept = opts.preferred.filter((set) => set.every((n) => freeSet.has(n)));
      if (kept.length) return kept.slice(0, MAX_GUARD_CANDIDATES);
    }

    return enumerateCandidates(free, bowlingLaneCount(opts.players)).slice(0, MAX_GUARD_CANDIDATES);
  } catch (err) {
    // A lane preference must never cost a booking. If we cannot read the floor we simply
    // do not have an opinion, and the vendor assigns as it always has.
    console.warn("[immediate-lane-guard] floor read failed (vendor will choose):", err);
    return [];
  }
}
