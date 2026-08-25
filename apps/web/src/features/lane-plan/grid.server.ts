/**
 * Lane arrangement — build a `LaneGrid` from the vendor. Server only.
 *
 * The grid is QAMF, never Neon. `bowling_reservations` only learns about a front-desk
 * booking when its lane OPENS, so leagues, maintenance blocks and any walk-in that never
 * opened are invisible to our DB — on FM Saturday 2026-08-22 that was 56 of 130
 * reservations. See tasks/lane-arrangement-plan.md §3.
 */
import {
  listLanes,
  searchReservations,
  toCenterLocalIso,
  type Reservation,
} from "@/lib/qamf-bowling";
import type { BusyInterval, LaneGrid } from "./types";

/**
 * How far back to widen the search window.
 *
 * `reservations/search` returns reservations whose lane STARTS inside the range, so a
 * session already running when the window opens is otherwise missed entirely — the exact
 * class of bug that would let us double-book a lane. Longest observed session is ~180 min
 * (league blocks run 150); 240 buys margin without meaningfully costing anything.
 */
export const MAX_SESSION_MINUTES = 240;

/** Statuses that mean the reservation no longer occupies its lane. */
const DEAD_STATUSES = new Set(["Canceled", "NoShow"]);

/**
 * How long past a running lane's estimated close we keep treating it as busy.
 *
 * `ClosedAt` is explicitly an ESTIMATE for a lane opened directly in Conqueror, and real
 * sessions overrun: Naples lane 27 at 23:48 on 2026-08-24 was still running a booking
 * whose window ended at 23:45. Handing the next group a lane the last group is still on
 * is far worse than holding it a few extra minutes.
 */
export const OPEN_LANE_GRACE_MINUTES = 15;

/**
 * Occupancy that only the FLOOR knows about.
 *
 * Two cases, both seen live and neither visible in the schedule:
 *  - a session running past its booked end time
 *  - a lane opened straight in Conqueror with `Reservation: null`, which no reservation
 *    search will ever return
 *
 * Emitted as real busy intervals so every placement decision respects them, and marked
 * `isBlock` so nothing ever tries to move them.
 */
export function toFloorIntervals(liveLanes: LaneGrid["liveLanes"], nowMs: number): BusyInterval[] {
  const graceMs = OPEN_LANE_GRACE_MINUTES * 60_000;
  const out: BusyInterval[] = [];
  for (const l of liveLanes) {
    if (l.status !== "Open") continue;
    const endMs = Math.max(l.closedAtMs ?? nowMs, nowMs) + graceMs;
    out.push({
      source: "floor",
      laneNumber: l.laneNumber,
      startMs: nowMs,
      endMs,
      reservationId: l.reservationId ?? `floor:lane-${l.laneNumber}`,
      laneStatus: "Running",
      reservationStatus: "Arrived",
      kind: l.reservationId ? "running session" : "lane opened in Conqueror",
      isBlock: true,
      webOfferId: null,
      players: 0,
      title: l.reservationId ? `running ${l.reservationId}` : `lane ${l.laneNumber} open`,
      createdAtMs: null,
    });
  }
  return out;
}

/**
 * Reservation categories that hold a lane but are not sellable open play.
 *
 * These still occupy the grid — a league on lanes 21-28 is as real as a paying group —
 * but they are never movable and never counted as revenue in the retrospective.
 * Matched loosely because `Type.Description` is free text configured per center
 * ("Non-bookable" at FM, "Non - Bookable" at Naples).
 */
export function isBlockKind(description: string | undefined): boolean {
  const d = (description ?? "").toLowerCase().replace(/[\s-]+/g, "");
  return d.includes("nonbookable") || d.includes("maintenance") || d.includes("league");
}

/** Flatten reservations into per-lane busy intervals. */
export function toBusyIntervals(reservations: readonly Reservation[]): BusyInterval[] {
  const out: BusyInterval[] = [];
  for (const r of reservations) {
    if (DEAD_STATUSES.has(String(r.Status))) continue;
    const kind = r.Type?.Description ?? "";
    const isBlock = isBlockKind(kind);
    const players = r.TotalPlayers ?? 0;
    for (const lane of r.Lanes ?? []) {
      const startMs = Date.parse(lane.StartTime);
      const endMs = Date.parse(lane.EndTime);
      // A zero- or negative-duration lane is vendor noise (it happens on lanes created
      // with an empty player list) and must not be treated as occupancy.
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) continue;
      out.push({
        source: "schedule",
        laneNumber: lane.LaneNumber,
        startMs,
        endMs,
        reservationId: r.Id,
        laneStatus: String(lane.Status ?? ""),
        reservationStatus: String(r.Status ?? ""),
        kind,
        isBlock,
        webOfferId: r.WebOffer?.Id ?? null,
        players,
        title: r.Title ?? "",
        createdAtMs: r.CreatedAt ? Date.parse(r.CreatedAt) || null : null,
      });
    }
  }
  return out;
}

/**
 * Read the authoritative lane grid for a window.
 *
 * Fails loudly rather than returning a partial grid: a grid that silently omits
 * occupancy is worse than no grid at all, because every caller would read the missing
 * lanes as free and double-book them.
 */
export async function buildGrid(
  centerId: number,
  windowStartMs: number,
  windowEndMs: number,
): Promise<LaneGrid> {
  const searchStartMs = windowStartMs - MAX_SESSION_MINUTES * 60_000;
  const [reservations, lanes] = await Promise.all([
    searchReservations(centerId, toCenterLocalIso(searchStartMs), toCenterLocalIso(windowEndMs)),
    listLanes(centerId),
  ]);

  const errorLanes = new Set<number>();
  const openLanes = new Set<number>();
  for (const l of lanes) {
    if (l.Status === "Error") errorLanes.add(l.LaneNumber);
    if (l.Status === "Open") openLanes.add(l.LaneNumber);
  }

  const readAtMs = Date.now();
  const liveLanes = lanes.map((l) => ({
    laneNumber: l.LaneNumber,
    status: String(l.Status ?? ""),
    closedAtMs: l.ClosedAt ? Date.parse(l.ClosedAt) || null : null,
    reservationId: l.Reservation?.Id ?? null,
  }));

  return {
    centerId,
    lanes: lanes.map((l) => l.LaneNumber).sort((a, b) => a - b),
    errorLanes,
    openLanes,
    liveLanes,
    // Both reads, deliberately. The schedule alone would sell a lane out from under a
    // session that is running over, or one opened in Conqueror with no reservation at all.
    busy: [...toBusyIntervals(reservations), ...toFloorIntervals(liveLanes, readAtMs)],
    windowStartMs,
    windowEndMs,
    readAtMs,
  };
}

/**
 * Cross-check the schedule against the live floor — the owner's correctness bar
 * ("make sure it honors things that are already booked that are not in our database").
 *
 * `GET /lanes` is an independent read: it reports what is physically Open right now and
 * which reservation is on it. If a lane is Open but the grid thinks it is free, the grid
 * has a hole and nothing may be pinned until it is explained. The reverse (grid busy,
 * lane Closed) is normal — a booking that has not opened yet.
 *
 * Exit criterion for shadow -> live: zero gaps across a full weekend.
 */
export interface GridGap {
  lane: number;
  severity: "blocking" | "info";
  problem: string;
}

export function findGridGaps(grid: LaneGrid, atMs: number): GridGap[] {
  const gaps: GridGap[] = [];
  // Only the SCHEDULE half. The grid also carries floor-derived intervals, and comparing
  // those against the floor would just confirm itself — the point of this check is to
  // measure how much the schedule alone would have missed.
  const scheduled = grid.busy.filter((b) => b.source === "schedule");
  const busyNow = scheduled.filter((b) => atMs >= b.startMs && atMs < b.endMs);
  const busyLanes = new Set(busyNow.map((b) => b.laneNumber));
  const knownReservations = new Set(scheduled.map((b) => b.reservationId));

  for (const live of grid.liveLanes) {
    if (live.status !== "Open") continue;

    // Something is physically playing on a lane the SCHEDULE believes is free. The grid
    // now covers this from the floor read, so it is no longer a hole we would book into —
    // but it still needs surfacing, because the frequency tells us how far the schedule
    // can be trusted on its own.
    if (!busyLanes.has(live.laneNumber)) {
      const overrun =
        live.reservationId && knownReservations.has(live.reservationId)
          ? "its booked window has already ended (session running over)"
          : live.reservationId
            ? "and that reservation is not in the schedule at all"
            : "with no reservation attached — opened directly in Conqueror";
      gaps.push({
        lane: live.laneNumber,
        // Covered by the floor read, so not blocking; an unknown reservation still is.
        severity:
          live.reservationId && knownReservations.has(live.reservationId) ? "info" : "blocking",
        problem: `OPEN on the floor${live.reservationId ? ` running ${live.reservationId}` : ""}, schedule shows free — ${overrun}`,
      });
      continue;
    }

    // Softer, but the same class of blindness: the lane is busy in both views, yet the
    // reservation actually playing there never appeared in the search results at all.
    if (live.reservationId && !knownReservations.has(live.reservationId)) {
      gaps.push({
        lane: live.laneNumber,
        severity: "blocking",
        problem: `running reservation ${live.reservationId} is absent from the search window entirely`,
      });
      continue;
    }

    // Both views agree the lane is busy but on different reservations — usually a lane
    // opened for a walk-in on top of a booking, worth seeing but not a grid hole.
    if (live.reservationId && !busyNow.some((b) => b.reservationId === live.reservationId)) {
      gaps.push({
        lane: live.laneNumber,
        severity: "info",
        problem: `floor is running ${live.reservationId}; schedule has ${busyNow
          .filter((b) => b.laneNumber === live.laneNumber)
          .map((b) => b.reservationId)
          .join(", ")}`,
      });
    }
  }
  return gaps;
}
