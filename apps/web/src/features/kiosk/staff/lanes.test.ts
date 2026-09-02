import { describe, it, expect } from "vitest";
import type { BusyInterval, LaneGrid } from "~/features/lane-plan/types";
import { toFloorIntervals } from "~/features/lane-plan/grid.server";
import { flattenLaneGrid } from "./lanes";

const NOW = Date.parse("2026-09-01T20:00:00-04:00");
const MIN = 60_000;

function interval(over: Partial<BusyInterval>): BusyInterval {
  return {
    source: "schedule",
    laneNumber: 1,
    startMs: NOW - 30 * MIN,
    endMs: NOW + 30 * MIN,
    reservationId: "X1",
    laneStatus: "Confirmed",
    reservationStatus: "Arrived",
    kind: "Walk-in > Classic",
    isBlock: false,
    webOfferId: null,
    players: 4,
    title: "Smith party",
    createdAtMs: null,
    ...over,
  };
}

function grid(over: Partial<LaneGrid>): LaneGrid {
  return {
    centerId: 9172,
    lanes: [1, 2, 3, 4],
    errorLanes: new Set<number>(),
    openLanes: new Set<number>(),
    liveLanes: [],
    busy: [],
    windowStartMs: NOW - 15 * MIN,
    windowEndMs: NOW + 180 * MIN,
    readAtMs: NOW,
    ...over,
  };
}

describe("flattenLaneGrid", () => {
  it("maps busy / soon / free / error", () => {
    const g = grid({
      errorLanes: new Set([4]),
      busy: [
        interval({ laneNumber: 1 }),
        interval({
          laneNumber: 2,
          startMs: NOW + 60 * MIN,
          endMs: NOW + 120 * MIN,
          title: "League",
          isBlock: true,
          kind: "League",
        }),
      ],
    });
    const rows = flattenLaneGrid(g, NOW);
    expect(rows.map((r) => r.state)).toEqual(["busy", "soon", "free", "error"]);
    expect(rows[0].title).toBe("Smith party");
    expect(rows[0].untilMs).toBe(NOW + 30 * MIN);
    expect(rows[1].untilMs).toBe(NOW + 60 * MIN);
    expect(rows[1].isBlock).toBe(true);
  });

  it("a session running past its booked end still reads busy (floor interval)", () => {
    // The schedule says lane 1's booking ended 15 min ago; the floor says the
    // lane is still Open running that reservation. toFloorIntervals emits the
    // occupancy; the flatten must read it as busy, never free.
    const liveLanes = [{ laneNumber: 1, status: "Open", closedAtMs: NOW, reservationId: "X1" }];
    const scheduledEnd = new Map([["X1", NOW - 15 * MIN]]);
    const g = grid({
      openLanes: new Set([1]),
      liveLanes,
      busy: [
        interval({ laneNumber: 1, startMs: NOW - 120 * MIN, endMs: NOW - 15 * MIN }),
        ...toFloorIntervals(liveLanes, NOW, scheduledEnd),
      ],
    });
    const row = flattenLaneGrid(g, NOW)[0];
    expect(row.state).toBe("busy");
    // Held from NOW (already overran) plus the turnaround grace — in the future.
    expect(row.untilMs).toBeGreaterThan(NOW);
  });

  it("a lane opened in Conqueror with NO reservation reads busy", () => {
    const liveLanes = [{ laneNumber: 3, status: "Open", closedAtMs: NOW, reservationId: null }];
    const g = grid({
      openLanes: new Set([3]),
      liveLanes,
      busy: toFloorIntervals(liveLanes, NOW),
    });
    const row = flattenLaneGrid(g, NOW).find((r) => r.lane === 3)!;
    expect(row.state).toBe("busy");
  });

  it("never uses ClosedAt as an end time — every lane stamped ClosedAt≈now stays honest", () => {
    // The QAMF trap: EVERY lane reports ClosedAt ≈ now, Closed ones included.
    // If any code path read it as a close time, a busy lane would "free" at now.
    const liveLanes = [1, 2, 3, 4].map((n) => ({
      laneNumber: n,
      status: n === 1 ? "Open" : "Closed",
      closedAtMs: NOW, // the state-as-of stamp on every lane
      reservationId: n === 1 ? "X1" : null,
    }));
    const g = grid({
      openLanes: new Set([1]),
      liveLanes,
      busy: [
        interval({ laneNumber: 1, endMs: NOW + 45 * MIN }),
        ...toFloorIntervals(liveLanes, NOW, new Map([["X1", NOW + 45 * MIN]])),
      ],
    });
    const rows = flattenLaneGrid(g, NOW);
    // Lane 1 frees at its BOOKED end (+grace via the floor interval), not at "now".
    expect(rows[0].state).toBe("busy");
    expect(rows[0].untilMs!).toBeGreaterThanOrEqual(NOW + 45 * MIN);
    // The Closed lanes with the same ClosedAt stamp are simply free.
    expect(rows.slice(1).every((r) => r.state === "free")).toBe(true);
  });

  it("half-open intervals: an interval ending exactly at atMs does not read busy", () => {
    const g = grid({ busy: [interval({ laneNumber: 1, endMs: NOW })] });
    expect(flattenLaneGrid(g, NOW)[0].state).toBe("free");
  });
});
