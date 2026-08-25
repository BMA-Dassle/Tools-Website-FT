/**
 * Lane arrangement engine — unit tests.
 *
 * Fixtures mirror the ugly cases seen on real boards, not tidy ones: a league holding
 * eight lanes, a maintenance block, a session already running when the window opens, and
 * a front-desk booking we are not allowed to move.
 */
import { describe, expect, it } from "vitest";
import {
  freeLanes,
  freeRuns,
  isLaneFree,
  isMovable,
  isTruePair,
  mateOf,
  occupancyAt,
  pairOf,
  projectedOccupancy,
  wholeFreePairs,
} from "./grid";
import { bucketOf, buildOccupancyForecast, forecastAt } from "./forecast";
import { findGridGaps, OPEN_LANE_GRACE_MINUTES, toFloorIntervals } from "./grid.server";
import { deriveLaneGroups, allowedLanesFor, MIN_SAMPLES_FOR_CONFIDENCE } from "./lane-groups";
import { chooseLanes, enumerateCandidates, replayGreenfield, sweepDay } from "./policy";
import { spreadBias } from "./score";
import { DEFAULT_POLICY, type BusyInterval, type LaneGrid } from "./types";

const HOUR = 3600_000;
const T0 = Date.parse("2026-08-22T18:00:00.000-04:00"); // 6pm ET Saturday

function busy(
  lane: number,
  startHours: number,
  durationHours: number,
  overrides: Partial<BusyInterval> = {},
): BusyInterval {
  return {
    source: "schedule",
    laneNumber: lane,
    startMs: T0 + startHours * HOUR,
    endMs: T0 + (startHours + durationHours) * HOUR,
    reservationId: overrides.reservationId ?? `X${lane}${startHours}`,
    laneStatus: "Confirmed",
    reservationStatus: "Confirmed",
    kind: "Walk-in > Classic",
    isBlock: false,
    webOfferId: 152,
    players: 4,
    title: `Party ${lane}`,
    createdAtMs: T0 - 24 * HOUR,
    ...overrides,
  };
}

function grid(busyList: BusyInterval[], laneCount = 16, extra: Partial<LaneGrid> = {}): LaneGrid {
  return {
    centerId: 9172,
    lanes: Array.from({ length: laneCount }, (_, i) => i + 1),
    errorLanes: new Set(),
    openLanes: new Set(),
    liveLanes: [],
    busy: busyList,
    windowStartMs: T0 - 4 * HOUR,
    windowEndMs: T0 + 8 * HOUR,
    readAtMs: T0,
    ...extra,
  };
}

describe("pairing", () => {
  it("treats lanes as odd-even pairs, matching the physical house", () => {
    expect(pairOf(1)).toBe(1);
    expect(pairOf(2)).toBe(1);
    expect(pairOf(3)).toBe(2);
    expect(mateOf(5)).toBe(6);
    expect(mateOf(6)).toBe(5);
    expect(isTruePair(5, 6)).toBe(true);
    // 6-7 is adjacent on the floor but spans two settees — not a pair.
    expect(isTruePair(6, 7)).toBe(false);
  });
});

describe("occupancy", () => {
  it("treats touching intervals as non-overlapping", () => {
    const g = grid([busy(3, 0, 1)]);
    // A session ending at 7pm does not block one starting at 7pm.
    expect(isLaneFree(g, 3, T0 + HOUR, T0 + 2 * HOUR)).toBe(true);
    expect(isLaneFree(g, 3, T0 + 0.5 * HOUR, T0 + 2 * HOUR)).toBe(false);
  });

  it("counts a session already running when the window opens", () => {
    // Started 2h before T0 and runs 3h — the case a naive search window would miss.
    const g = grid([busy(4, -2, 3)]);
    expect(isLaneFree(g, 4, T0, T0 + HOUR)).toBe(false);
    expect(occupancyAt(g, T0)).toBe(1);
  });

  it("ignores the reservation being re-placed", () => {
    const g = grid([busy(4, 0, 2, { reservationId: "X999" })]);
    expect(isLaneFree(g, 4, T0, T0 + HOUR)).toBe(false);
    expect(isLaneFree(g, 4, T0, T0 + HOUR, "X999")).toBe(true);
  });

  it("never offers a lane under maintenance", () => {
    const g = grid([], 16, { errorLanes: new Set([7]) });
    expect(isLaneFree(g, 7, T0, T0 + HOUR)).toBe(false);
    expect(freeLanes(g, T0, T0 + HOUR)).not.toContain(7);
  });

  it("counts whole free pairs, the inventory a big group needs", () => {
    // Lane 1 busy breaks pair 1; lanes 5+6 busy breaks pair 3 entirely.
    const g = grid([busy(1, 0, 2), busy(5, 0, 2), busy(6, 0, 2)], 8);
    // Pairs are (1,2) (3,4) (5,6) (7,8). Only (3,4) and (7,8) are whole.
    expect(wholeFreePairs(g, T0, T0 + HOUR)).toBe(2);
  });

  it("reports contiguous free runs", () => {
    const g = grid([busy(3, 0, 2), busy(4, 0, 2)], 8);
    expect(freeRuns(g, T0, T0 + HOUR)).toEqual([
      [1, 2],
      [5, 6, 7, 8],
    ]);
  });
});

describe("movability", () => {
  it("freezes a lane that is physically running", () => {
    const g = grid([busy(3, 0, 2)], 16, { openLanes: new Set([3]) });
    expect(isMovable([g.busy[0]], g)).toBe(false);
  });

  it("freezes a group staff already set the lane up for", () => {
    const g = grid([busy(3, 0, 2, { laneStatus: "Ready" })]);
    expect(isMovable([g.busy[0]], g)).toBe(false);
  });

  it("freezes leagues and maintenance — never ours to move", () => {
    const g = grid([busy(3, 0, 2, { isBlock: true, kind: "League" })]);
    expect(isMovable([g.busy[0]], g)).toBe(false);
  });

  it("allows a plain confirmed booking", () => {
    const g = grid([busy(3, 0, 2)]);
    expect(isMovable([g.busy[0]], g)).toBe(true);
  });
});

describe("spread vs backfill — the owner's rule", () => {
  const req = (laneCount = 1) => ({
    laneCount,
    startMs: T0,
    endMs: T0 + 1.5 * HOUR,
    players: 4,
    webOfferId: 152,
    allowedLanes: null,
  });

  it("spreads onto a fresh pair when the house is empty", () => {
    const g = grid([], 16);
    expect(spreadBias(g, req(), DEFAULT_POLICY)).toBeGreaterThan(0.5);
    const { best } = chooseLanes(g, req(), DEFAULT_POLICY);
    expect(best).not.toBeNull();
    // Whatever lane it picks, the settee neighbour must be free.
    expect(isLaneFree(g, mateOf(best!.lanes[0]), T0, T0 + 1.5 * HOUR)).toBe(true);
  });

  it("winds the dial from spread to backfill as fresh pairs are spent", () => {
    // 16 lanes = 8 pairs. Take one lane of N pairs and watch the bias fall.
    const biasWith = (n: number) =>
      spreadBias(
        grid(
          Array.from({ length: n }, (_, i) => busy(i * 2 + 1, 0, 2)),
          16,
        ),
        req(),
        DEFAULT_POLICY,
      );
    expect(biasWith(0)).toBe(1); // empty house — spread freely
    expect(biasWith(6)).toBeGreaterThan(0);
    expect(biasWith(6)).toBeLessThan(biasWith(0));
    // Every pair now half-used: nothing fresh left, so spreading is no longer preferred.
    expect(biasWith(8)).toBeLessThanOrEqual(0);
  });

  it("still places when every pair is already half-used", () => {
    const g = grid(
      Array.from({ length: 8 }, (_, i) => busy(i * 2 + 1, 0, 2)),
      16,
    );
    const { best } = chooseLanes(g, req(), DEFAULT_POLICY);
    expect(best).not.toBeNull();
    expect(best!.lanes).toHaveLength(1);
    // The only lanes left are mates of occupied ones — it backfills rather than refusing.
    expect(best!.lanes[0] % 2).toBe(0);
  });

  it("keeps a two-lane party on one settee, not straddling two", () => {
    const g = grid([], 16);
    const { best } = chooseLanes(g, req(2), DEFAULT_POLICY);
    expect(best).not.toBeNull();
    expect(isTruePair(best!.lanes[0], best!.lanes[1])).toBe(true);
  });

  it("prefers spending a half-used pair over a whole one under pressure", () => {
    // Pairs (1,2)(3,4) half-used; (5,6)(7,8) whole and free.
    const g = grid([busy(1, 0, 2), busy(3, 0, 2)], 8);
    const bias = spreadBias(g, req(), DEFAULT_POLICY);
    // 2 whole pairs of 4 total, span 0.35*4 = 1.4 -> bias > 0, still spreading.
    expect(bias).toBeGreaterThan(0);
    const { best } = chooseLanes(g, req(), DEFAULT_POLICY);
    // With room to spare it should take a fresh pair rather than sit beside someone.
    expect([5, 6, 7, 8]).toContain(best!.lanes[0]);
  });

  it("never places on top of an existing booking", () => {
    const g = grid([busy(2, 0, 2), busy(4, 0, 2), busy(6, 0, 2)], 8);
    const { ranked } = chooseLanes(g, req(), DEFAULT_POLICY);
    for (const p of ranked) {
      expect([2, 4, 6]).not.toContain(p.lanes[0]);
    }
  });

  it("returns nothing placeable when the house is genuinely full", () => {
    const g = grid(
      Array.from({ length: 8 }, (_, i) => busy(i + 1, 0, 2)),
      8,
    );
    const { best, reason } = chooseLanes(g, req(), DEFAULT_POLICY);
    expect(best).toBeNull();
    expect(reason).toMatch(/no lane set free/);
  });
});

describe("candidate enumeration", () => {
  it("offers only contiguous sets when contiguous sets exist", () => {
    expect(enumerateCandidates([1, 2, 3, 7, 8], 2)).toEqual([
      [1, 2],
      [2, 3],
      [7, 8],
    ]);
  });

  it("falls back to non-contiguous rather than refusing a group", () => {
    const out = enumerateCandidates([1, 5, 9], 2);
    expect(out.length).toBeGreaterThan(0);
    expect(out[0]).toEqual([1, 5]);
  });
});

describe("sweep", () => {
  const opts = { fromMs: T0 - HOUR, toMs: T0 + 6 * HOUR, nowMs: T0 - 4 * HOUR };

  it("splits two parties sharing one settee", () => {
    // Lanes 13 and 14 are the SAME pair — two unrelated parties on one settee.
    const g = grid(
      [busy(13, 0, 1.5, { reservationId: "XA" }), busy(14, 0, 1.5, { reservationId: "XB" })],
      16,
    );
    const { moves } = sweepDay(g, DEFAULT_POLICY, opts);
    expect(moves.length).toBeGreaterThan(0);
    // After the sweep the two must not share a pair.
    const finalLanes = new Map<string, number>();
    for (const id of ["XA", "XB"]) {
      const m = moves.find((x) => x.reservationId === id);
      finalLanes.set(id, m ? m.to[0] : id === "XA" ? 13 : 14);
    }
    expect(pairOf(finalLanes.get("XA")!)).not.toBe(pairOf(finalLanes.get("XB")!));
  });

  it("never proposes moving a league or maintenance block", () => {
    const g = grid(
      [21, 22, 23, 24].map((l) =>
        busy(l, 0, 2.5, { reservationId: "C-LEAGUE", isBlock: true, kind: "League" }),
      ),
      28,
    );
    const { moves } = sweepDay(g, DEFAULT_POLICY, opts);
    expect(moves).toHaveLength(0);
  });

  it("leaves front-desk bookings alone by default", () => {
    const g = grid(
      [busy(13, 0, 1.5, { reservationId: "C500" }), busy(14, 0, 1.5, { reservationId: "C501" })],
      16,
    );
    expect(sweepDay(g, DEFAULT_POLICY, opts).moves).toHaveLength(0);
    // …unless explicitly allowed.
    const permissive = { ...DEFAULT_POLICY, moveConquerorBookings: true };
    expect(sweepDay(g, permissive, opts).moves.length).toBeGreaterThan(0);
  });

  it("does not churn the board for a trivial gain", () => {
    // A single already sitting on a clean fresh pair has nothing to gain.
    const g = grid([busy(5, 0, 1.5)], 16);
    const { moves } = sweepDay(g, DEFAULT_POLICY, opts);
    expect(moves).toHaveLength(0);
  });

  it("freezes anything starting inside the freeze window", () => {
    const g = grid(
      [busy(13, 0, 1.5, { reservationId: "XA" }), busy(14, 0, 1.5, { reservationId: "XB" })],
      16,
    );
    const soon = sweepDay(g, DEFAULT_POLICY, {
      ...opts,
      nowMs: T0 - 10 * 60_000,
      freezeMinutes: 90,
    });
    expect(soon.moves).toHaveLength(0);
    expect(soon.frozen).toBeGreaterThan(0);
  });

  it("proposed moves never collide with each other", () => {
    const g = grid(
      [1, 2, 3, 4, 9, 10].map((l, i) => busy(l, 0, 1.5, { reservationId: `X${i}` })),
      16,
    );
    const { moves } = sweepDay(g, DEFAULT_POLICY, opts);
    const finals = new Map<number, string>();
    for (const b of g.busy) {
      const m = moves.find((x) => x.reservationId === b.reservationId);
      const lane = m ? m.to[0] : b.laneNumber;
      expect(finals.has(lane)).toBe(false);
      finals.set(lane, b.reservationId);
    }
  });
});

describe("greenfield replay", () => {
  it("places in creation order, not difficulty order", () => {
    const g = grid(
      [
        busy(1, 0, 1.5, { reservationId: "XLATE", createdAtMs: T0 - HOUR }),
        busy(2, 0, 1.5, { reservationId: "XEARLY", createdAtMs: T0 - 100 * HOUR }),
      ],
      16,
    );
    const { placed } = replayGreenfield(g, DEFAULT_POLICY, {
      fromMs: T0 - HOUR,
      toMs: T0 + 6 * HOUR,
    });
    expect(placed.size).toBe(2);
    // Both placed, on different pairs — the earlier booking got first pick.
    const lanes = [...placed.values()].flat();
    expect(new Set(lanes).size).toBe(2);
    expect(pairOf(lanes[0])).not.toBe(pairOf(lanes[1]));
  });

  it("leaves blocks and front-desk bookings exactly where they are", () => {
    const g = grid(
      [
        busy(21, 0, 2, { reservationId: "C-L", isBlock: true, kind: "League" }),
        busy(9, 0, 2, { reservationId: "C900" }),
      ],
      28,
    );
    const { placed } = replayGreenfield(g, DEFAULT_POLICY, {
      fromMs: T0 - HOUR,
      toMs: T0 + 6 * HOUR,
    });
    expect(placed.has("C-L")).toBe(false);
    expect(placed.has("C900")).toBe(false);
  });
});

describe("the floor overrules the schedule", () => {
  // Both cases observed live at Naples 2026-08-24 23:48 by scripts/lane-grid-check.mts.
  const live = (
    laneNumber: number,
    status: string,
    closedAtMs: number | null,
    reservationId: string | null,
  ) => ({ laneNumber, status, closedAtMs, reservationId });

  it("keeps a lane busy when the session is running past its booked end", () => {
    // Booked 10:15-11:45; it is 11:48 and the lane is still Open until ~11:50.
    const bookedEnd = T0 + 1 * HOUR;
    const now = bookedEnd + 3 * 60_000;
    const floor = toFloorIntervals([live(27, "Open", now + 2 * 60_000, "X85285")], now);
    expect(floor).toHaveLength(1);
    expect(floor[0].source).toBe("floor");
    // Held past the estimated close, because ClosedAt is an estimate and groups overrun.
    expect(floor[0].endMs).toBeGreaterThan(now + OPEN_LANE_GRACE_MINUTES * 60_000);

    const g = grid([busy(27, 0, 1, { reservationId: "X85285" }), ...floor], 32);
    // The schedule alone would have called it free the moment the booking ended.
    expect(
      isLaneFree(
        { ...g, busy: g.busy.filter((b) => b.source === "schedule") },
        27,
        now,
        now + HOUR,
      ),
    ).toBe(true);
    // With the floor read it is correctly still busy.
    expect(isLaneFree(g, 27, now, now + 5 * 60_000)).toBe(false);
  });

  it("blocks a lane opened in Conqueror that no reservation explains", () => {
    const now = T0;
    const floor = toFloorIntervals([live(8, "Open", now + 4 * 60_000, null)], now);
    expect(floor).toHaveLength(1);
    expect(floor[0].reservationId).toBe("floor:lane-8");
    expect(floor[0].isBlock).toBe(true);
    const g = grid(floor, 32);
    expect(isLaneFree(g, 8, now, now + 5 * 60_000)).toBe(false);
    // And it must never be proposed for a move — there is no booking to move.
    expect(isMovable(floor, g)).toBe(false);
  });

  it("ignores lanes that are merely Closed — Closed means free and ready", () => {
    expect(toFloorIntervals([live(3, "Closed", null, null)], T0)).toHaveLength(0);
  });

  it("gap check reports only what the SCHEDULE missed, not the floor read it already has", () => {
    const now = T0;
    const liveLanes = [live(8, "Open", now + 4 * 60_000, null)];
    const floor = toFloorIntervals(liveLanes, now);
    const g = grid(floor, 32, { openLanes: new Set([8]), liveLanes });
    // The grid covers lane 8 via the floor, but the check must still say the schedule
    // knew nothing about it — otherwise it would trivially agree with itself.
    const gaps = findGridGaps(g, now);
    expect(gaps).toHaveLength(1);
    expect(gaps[0].lane).toBe(8);
    expect(gaps[0].severity).toBe("blocking");
  });

  it("treats a known booking running over as informational, not a hole", () => {
    const now = T0 + HOUR + 3 * 60_000;
    const liveLanes = [live(27, "Open", now + 2 * 60_000, "X85285")];
    const g = grid(
      [busy(27, 0, 1, { reservationId: "X85285" }), ...toFloorIntervals(liveLanes, now)],
      32,
      { openLanes: new Set([27]), liveLanes },
    );
    const gaps = findGridGaps(g, now);
    expect(gaps).toHaveLength(1);
    expect(gaps[0].severity).toBe("info");
    expect(gaps[0].problem).toMatch(/running over/);
  });
});

describe("lane groups", () => {
  const res = (id: string, offer: number, lanes: number[]) => ({
    Id: id,
    Status: "Completed" as const,
    WebOffer: { Id: offer },
    Lanes: lanes.map((l) => ({
      Id: `l${l}`,
      Status: "Completed" as const,
      LaneNumber: l,
      StartTime: "2026-08-22T18:00:00-04:00",
      EndTime: "2026-08-22T19:30:00-04:00",
    })),
  });

  it("learns the lane set an offer actually uses", () => {
    const history = Array.from({ length: MIN_SAMPLES_FOR_CONFIDENCE }, (_, i) =>
      res(`X${i}`, 155, [5 + (i % 4), 6 + (i % 4)]),
    );
    const groups = deriveLaneGroups(history);
    expect(groups.get(155)!.confident).toBe(true);
    expect(allowedLanesFor(groups, 155)).toEqual([5, 6, 7, 8, 9]);
  });

  it("drops rare strays — presence is not membership", () => {
    // The real shape of FM offer 154 over 60 days: lanes 13-28 carried 9-36 observations
    // each, while 6/7/9/10/12 appeared once or twice. Pinning to lane 6 was rejected live
    // with 409 LanesNotCompatible on 2026-08-25 — those strays are bookings staff moved
    // onto a lane inside Conqueror, which does not enforce the web offer's lane group.
    const history = [
      ...Array.from({ length: 120 }, (_, i) => res(`Xreal${i}`, 154, [13 + (i % 16)])),
      res("Xstray1", 154, [6]),
      res("Xstray2", 154, [7]),
      res("Xstray3", 154, [7]),
      res("Xstray4", 154, [12]),
    ];
    const groups = deriveLaneGroups(history);
    const g = groups.get(154)!;
    expect(g.confident).toBe(true);
    expect(allowedLanesFor(groups, 154)).toEqual([
      13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28,
    ]);
    expect(g.outliers).toEqual([6, 7, 12]);
    // The counts survive so a rejected pin can be explained rather than just failing.
    expect(g.counts.get(6)).toBe(1);
    expect(g.counts.get(13)).toBeGreaterThan(5);
  });

  it("keeps a lane that is merely less popular, not an outlier", () => {
    // 30 vs 8 is a real spread of demand across a group, not noise. 8 clears both the
    // 10%-of-busiest bar and the absolute floor.
    const history = [
      ...Array.from({ length: 30 }, (_, i) => res(`Xa${i}`, 200, [5])),
      ...Array.from({ length: 8 }, (_, i) => res(`Xb${i}`, 200, [6])),
    ];
    expect(allowedLanesFor(deriveLaneGroups(history), 200)).toEqual([5, 6]);
  });

  it("refuses to restrict on thin evidence — a wrong fence is worse than none", () => {
    const groups = deriveLaneGroups([res("X1", 999, [3])]);
    expect(groups.get(999)!.confident).toBe(false);
    expect(allowedLanesFor(groups, 999)).toBeNull();
  });

  it("ignores canceled bookings", () => {
    const cancelled = { ...res("X1", 77, [3]), Status: "Canceled" as const };
    expect(deriveLaneGroups([cancelled]).has(77)).toBe(false);
  });
});

describe("forecast", () => {
  it("assigns post-midnight play to the night it belongs to", () => {
    // 1am Sunday is Saturday night's business.
    const oneAm = Date.parse("2026-08-23T01:00:00.000-04:00");
    const { dow, bucket } = bucketOf(oneAm);
    expect(dow).toBe(6); // Saturday
    expect(bucket).toBeGreaterThan(0);
    const sixPm = Date.parse("2026-08-22T18:00:00.000-04:00");
    expect(bucketOf(sixPm).dow).toBe(6);
    expect(bucket).toBeGreaterThan(bucketOf(sixPm).bucket);
  });

  it("returns null rather than guessing from thin history", () => {
    const one = [
      {
        Id: "X1",
        Status: "Completed" as const,
        Lanes: [
          {
            Id: "l1",
            Status: "Completed" as const,
            LaneNumber: 1,
            StartTime: "2026-08-22T18:00:00-04:00",
            EndTime: "2026-08-22T19:00:00-04:00",
          },
        ],
      },
    ];
    const f = buildOccupancyForecast(one, 16);
    expect(forecastAt(f, T0)).toBeNull();
  });

  it("raises the pressure signal above what the board alone shows", () => {
    const history = [0, 7, 14, 21].flatMap((offsetDays) =>
      Array.from({ length: 12 }, (_, lane) => ({
        Id: `X${offsetDays}-${lane}`,
        Status: "Completed" as const,
        Lanes: [
          {
            Id: `l${lane}`,
            Status: "Completed" as const,
            LaneNumber: lane + 1,
            StartTime: new Date(T0 - offsetDays * 24 * HOUR).toISOString(),
            EndTime: new Date(T0 - offsetDays * 24 * HOUR + 1.5 * HOUR).toISOString(),
          },
        ],
      })),
    );
    const f = buildOccupancyForecast(history, 16);
    const quiet = grid([], 16, { forecast: f });
    const p = projectedOccupancy(quiet, T0, T0 + HOUR);
    // The board is empty, but this weekday/time historically runs busy.
    expect(p.observedPeak).toBe(0);
    expect(p.forecastPeak).toBeGreaterThan(0);
    expect(p.peak).toBeGreaterThan(p.observedPeak);
  });
});
