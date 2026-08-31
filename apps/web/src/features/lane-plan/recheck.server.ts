/**
 * Lane arrangement — the near-start re-check.
 *
 * A lane is chosen ONCE, when the hold is created, and the board does not hold still after
 * that. A session runs over. Staff open a lane in Conqueror. A group is moved by hand. By
 * the time the guest walks in, the lane we picked at 2pm for their 6pm booking may have
 * somebody on it — which is exactly the failure the owner hit on 2026-08-31, arriving to
 * find their kiosk booking on lane 1 while lane 1 was still running.
 *
 * So shortly before each booking starts we look again.
 *
 * REPAIR ONLY — never re-optimise.
 *
 * This runs minutes before a guest arrives, and by then a lane number may already have been
 * shown to them on the kiosk confirmation. Shuffling somebody for a better score at that
 * point is pure churn and risks sending them to a lane they were not told about. So the
 * only question asked here is the narrow one: **is the lane they are booked on actually
 * going to be free?** If yes, nothing happens, no matter how much prettier another lane
 * would look. If no, they were going to be walked onto an occupied lane anyway, and moving
 * them is strictly better than not.
 */
import { byReservation, isLaneFree, isMovable } from "./grid";
import { placeReservationOnBestLane } from "./place.server";
import { buildGrid, MAX_SESSION_MINUTES } from "./grid.server";
import { DEFAULT_POLICY, type LaneGrid, type LanePolicy } from "./types";

/**
 * How far ahead to look.
 *
 * Long enough to cover the owner's "bowling in the next 30 minutes", plus room for the
 * cron's own interval so no booking slips between two runs.
 */
export const RECHECK_HORIZON_MINUTES = 40;

export interface Repair {
  reservationId: string;
  lanes: number[];
  startMs: number;
  /** Lanes of theirs that will NOT be free — the reason we are touching this at all. */
  blocked: number[];
}

/**
 * Which imminent bookings are sitting on a lane that will not be free for them?
 *
 * Pure, so the rule can be tested against an ugly board rather than inferred from logs.
 */
export function findImminentRepairs(
  grid: LaneGrid,
  opts: { nowMs: number; horizonMs: number; policy?: LanePolicy },
): Repair[] {
  const policy = opts.policy ?? DEFAULT_POLICY;
  const out: Repair[] = [];

  for (const intervals of byReservation(grid).values()) {
    const head = intervals[0];
    if (head.isBlock) continue;
    // Floor intervals are lane state, not bookings — there is nobody to move.
    if (intervals.every((i) => i.source === "floor")) continue;
    if (!policy.moveConquerorBookings && head.reservationId.startsWith("C")) continue;

    const startMs = Math.min(...intervals.map((i) => i.startMs));
    if (startMs < opts.nowMs || startMs > opts.nowMs + opts.horizonMs) continue;

    // Already running, already set up by staff, already checked in — not ours any more.
    if (!isMovable(intervals, grid)) continue;

    const endMs = Math.max(...intervals.map((i) => i.endMs));
    const blocked = intervals
      .filter((i) => !isLaneFree(grid, i.laneNumber, startMs, endMs, head.reservationId))
      .map((i) => i.laneNumber);

    if (blocked.length > 0) {
      out.push({
        reservationId: head.reservationId,
        lanes: intervals.map((i) => i.laneNumber),
        startMs,
        blocked,
      });
    }
  }

  return out.sort((a, b) => a.startMs - b.startMs);
}

export interface RecheckReport {
  scanned: number;
  repairs: Repair[];
  moved: Array<{ reservationId: string; from: number[]; to: number[] }>;
  failed: Array<{ reservationId: string; reason: string }>;
}

/**
 * Find and fix imminent bookings whose lane is not going to be free.
 *
 * NEVER THROWS. Every guest already has a booking; the worst outcome here is that we fail
 * to improve one, which is where they were anyway.
 */
export async function recheckImminentLanes(opts: {
  centerId: number;
  nowMs?: number;
  horizonMinutes?: number;
  policy?: LanePolicy;
}): Promise<RecheckReport> {
  const nowMs = opts.nowMs ?? Date.now();
  const horizonMs = (opts.horizonMinutes ?? RECHECK_HORIZON_MINUTES) * 60_000;
  const report: RecheckReport = { scanned: 0, repairs: [], moved: [], failed: [] };

  try {
    // Reach past the horizon by a full session so a booking that starts inside the window
    // is measured against everything that could still be running when it does.
    const grid = await buildGrid(
      opts.centerId,
      nowMs,
      nowMs + horizonMs + MAX_SESSION_MINUTES * 60_000,
    );
    report.scanned = byReservation(grid).size;
    report.repairs = findImminentRepairs(grid, { nowMs, horizonMs, policy: opts.policy });
  } catch (err) {
    report.failed.push({
      reservationId: "(grid)",
      reason: err instanceof Error ? err.message : String(err),
    });
    return report;
  }

  // Sequentially, each against a freshly read board. Two repairs planned off ONE snapshot
  // could both be sent to the same free lane — the bug that once put two guests on one
  // lane in the sweep. Re-reading between moves makes that impossible by construction, and
  // repairs are rare enough that the extra reads cost nothing.
  for (const repair of report.repairs) {
    const result = await placeReservationOnBestLane({
      centerId: opts.centerId,
      reservationId: repair.reservationId,
      policy: opts.policy,
      // Staying put is not an option: the lane they are on will not be free.
      force: true,
    });
    if (result.moved) {
      report.moved.push({ reservationId: repair.reservationId, from: result.from, to: result.to });
    } else {
      report.failed.push({ reservationId: repair.reservationId, reason: result.reason });
    }
  }

  return report;
}
