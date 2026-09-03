import { beforeEach, describe, expect, it, vi } from "vitest";

// `vi.hoisted` so the spy exists before the hoisted `vi.mock` factory runs, and the module
// gets the spy ITSELF rather than a wrapper around it.
const { listLanes } = vi.hoisted(() => ({ listLanes: vi.fn() }));
vi.mock("@/lib/qamf-bowling", () => ({ listLanes }));

import {
  freeLaneCandidates,
  immediateLaneGuardEnabled,
  isImmediateStart,
  IMMEDIATE_START_WINDOW_MINUTES,
} from "./immediate-lane-guard";

const MIN = 60_000;
const NOW = Date.parse("2026-08-31T18:00:00.000-04:00");
const lane = (LaneNumber: number, Status: string) => ({ LaneNumber, Status });

beforeEach(() => listLanes.mockReset());

describe("is the guest about to walk to the lane?", () => {
  it("covers a booking starting now or within the window", () => {
    expect(isImmediateStart(NOW, NOW)).toBe(true);
    expect(isImmediateStart(NOW + 5 * MIN, NOW)).toBe(true);
    expect(isImmediateStart(NOW + (IMMEDIATE_START_WINDOW_MINUTES - 1) * MIN, NOW)).toBe(true);
  });

  it("tolerates a start slightly in the past — kiosk walk-ups floor to 5 minutes", () => {
    expect(isImmediateStart(NOW - 4 * MIN, NOW)).toBe(true);
  });

  it("declines to have an opinion about a booking for later", () => {
    // Beyond this the board turns over, and a floor snapshot taken now would be worse
    // than nothing. That horizon belongs to the near-start re-check.
    expect(isImmediateStart(NOW + (IMMEDIATE_START_WINDOW_MINUTES + 5) * MIN, NOW)).toBe(false);
    expect(isImmediateStart(NOW + 6 * 60 * MIN, NOW)).toBe(false);
    expect(isImmediateStart(Number.NaN, NOW)).toBe(false);
  });
});

describe("the guard's own kill switch", () => {
  it('is ON unless set to exactly "false", and is NOT the arrangement flag', () => {
    const prevGuard = process.env.IMMEDIATE_LANE_GUARD;
    const prevArrange = process.env.LANE_ARRANGEMENT;
    try {
      delete process.env.IMMEDIATE_LANE_GUARD;
      expect(immediateLaneGuardEnabled()).toBe(true);
      // Killing the arrangement pilot must NOT stop us checking whether a lane is occupied.
      process.env.LANE_ARRANGEMENT = "false";
      expect(immediateLaneGuardEnabled()).toBe(true);
      process.env.IMMEDIATE_LANE_GUARD = "false";
      expect(immediateLaneGuardEnabled()).toBe(false);
    } finally {
      if (prevGuard === undefined) delete process.env.IMMEDIATE_LANE_GUARD;
      else process.env.IMMEDIATE_LANE_GUARD = prevGuard;
      if (prevArrange === undefined) delete process.env.LANE_ARRANGEMENT;
      else process.env.LANE_ARRANGEMENT = prevArrange;
    }
  });
});

describe("candidates come only from lanes nobody is on", () => {
  it("never offers a lane that is physically Open", async () => {
    // The 8/31 board: 1-3 running, 4-8 free. Lane 1 is what QAMF would have picked.
    listLanes.mockResolvedValue([
      lane(1, "Open"),
      lane(2, "Open"),
      lane(3, "Open"),
      lane(4, "Closed"),
      lane(5, "Closed"),
      lane(6, "Closed"),
      lane(7, "Closed"),
      lane(8, "Closed"),
    ]);
    const { candidates: sets } = await freeLaneCandidates({ centerId: 11542, players: 4 });
    expect(sets.length).toBeGreaterThan(0);
    expect(sets.flat()).not.toContain(1);
    expect(sets[0]).toEqual([4]); // ascending — the vendor's own preference, minus the busy ones
  });

  it("skips Error and unknown lane states too, not just Open", async () => {
    listLanes.mockResolvedValue([lane(1, "Error"), lane(2, "Running"), lane(3, "Closed")]);
    const { candidates: sets } = await freeLaneCandidates({ centerId: 9172, players: 2 });
    expect(sets.flat()).toEqual([3]);
  });

  it("gives a big party the lanes it needs, together", async () => {
    listLanes.mockResolvedValue([1, 2, 3, 4, 5, 6, 7, 8].map((n) => lane(n, "Closed")));
    // 8 players at 6 per lane = 2 lanes, and they must sit next to each other.
    const { candidates: sets } = await freeLaneCandidates({ centerId: 11542, players: 8 });
    expect(sets[0]).toHaveLength(2);
    expect(sets[0][1] - sets[0][0]).toBe(1);
  });

  it("keeps the arrangement engine's ORDER but drops what the floor says is busy", async () => {
    // The two reads happen moments apart and can disagree; the floor wins.
    listLanes.mockResolvedValue([
      lane(1, "Open"),
      lane(2, "Closed"),
      lane(6, "Closed"),
      lane(7, "Closed"),
    ]);
    const { candidates: sets } = await freeLaneCandidates({
      centerId: 11542,
      players: 4,
      preferred: [[1], [6], [2]],
    });
    expect(sets).toEqual([[6], [2]]);
  });

  it("has NO opinion when every lane is busy — the vendor still takes the booking", async () => {
    listLanes.mockResolvedValue([lane(1, "Open"), lane(2, "Open")]);
    expect((await freeLaneCandidates({ centerId: 11542, players: 4 })).candidates).toEqual([]);
  });

  it("has NO opinion when the floor read fails — a lane preference never costs a booking", async () => {
    listLanes.mockRejectedValueOnce(new Error("QAMF timeout"));
    expect((await freeLaneCandidates({ centerId: 11542, players: 4 })).candidates).toEqual([]);
  });
});

describe("the guard never offers a lane outside the product's section", () => {
  const FM_REGULAR = [13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28];

  it("skips free Old Time lanes for a Regular booking", async () => {
    // The 2026-09-02 bug exactly: lanes 1-4 free, so ascending offered 1, 2, 3 — all Old
    // Time, all refused, budget gone, fall open. Production logged 18 such refusals in a day.
    listLanes.mockResolvedValue([1, 2, 3, 4, 5, 13, 15, 19].map((n) => lane(n, "Closed")));
    const { candidates } = await freeLaneCandidates({
      centerId: 9172,
      players: 4,
      allowedLanes: FM_REGULAR,
    });
    expect(candidates.flat()).not.toContain(1);
    expect(candidates.flat()).not.toContain(5); // VIP either
    expect(candidates).toEqual([[13], [15], [19]]);
  });

  it("has no opinion when the section is full, rather than reaching outside it", async () => {
    // Old Time and VIP are wide open; a Regular booking still must not be sent there.
    listLanes.mockResolvedValue([1, 2, 3, 4, 5, 6].map((n) => lane(n, "Closed")));
    const { candidates } = await freeLaneCandidates({
      centerId: 9172,
      players: 4,
      allowedLanes: FM_REGULAR,
    });
    expect(candidates).toEqual([]);
  });

  it("still drops a section lane the floor says is occupied", async () => {
    listLanes.mockResolvedValue([lane(13, "Open"), lane(15, "Closed"), lane(19, "Closed")]);
    const { candidates } = await freeLaneCandidates({
      centerId: 9172,
      players: 4,
      allowedLanes: FM_REGULAR,
    });
    expect(candidates).toEqual([[15], [19]]);
  });

  it("is unrestricted when no section is known — never refuses a lane it should offer", async () => {
    listLanes.mockResolvedValue([1, 2, 3].map((n) => lane(n, "Closed")));
    const { candidates } = await freeLaneCandidates({ centerId: 9172, players: 4 });
    expect(candidates).toEqual([[1], [2], [3]]);
  });
});
