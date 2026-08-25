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

  return {
    centerId,
    lanes: lanes.map((l) => l.LaneNumber).sort((a, b) => a - b),
    errorLanes,
    openLanes,
    busy: toBusyIntervals(reservations),
    windowStartMs,
    windowEndMs,
    readAtMs: Date.now(),
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
export function findGridGaps(
  grid: LaneGrid,
  atMs: number,
): Array<{ lane: number; problem: string }> {
  const gaps: Array<{ lane: number; problem: string }> = [];
  const busyNow = new Set(
    grid.busy.filter((b) => atMs >= b.startMs && atMs < b.endMs).map((b) => b.laneNumber),
  );
  for (const lane of grid.openLanes) {
    if (!busyNow.has(lane)) {
      gaps.push({
        lane,
        problem: "lane is OPEN on the floor but the grid shows it free — occupancy is missing",
      });
    }
  }
  return gaps;
}
