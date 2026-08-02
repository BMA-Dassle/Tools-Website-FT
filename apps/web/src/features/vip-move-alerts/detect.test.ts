import { describe, expect, it } from "vitest";
import type { ComboGroup } from "~/features/reservations-admin/combo-board";
import { etWallMs } from "~/features/reservations-admin/format";
import type { ComboScheduleStep, Reservation } from "~/features/reservations-admin/types";
import { detectPendingMoves, refreshMoves } from "./detect";

/** All times on one fixed evening; nowMs always comes from at(). */
const at = (iso: string) => etWallMs(iso);

const race = (over: Partial<ComboScheduleStep> = {}): ComboScheduleStep => ({
  icon: "",
  label: "Starter Race · Blue",
  iso: "2026-07-10T20:00:00",
  loc: "FastTrax",
  durationMin: 10,
  ...over,
});

const bowling = (over: Partial<ComboScheduleStep> = {}): ComboScheduleStep => ({
  icon: "",
  label: "VIP Bowling",
  iso: "2026-07-10T20:45:00",
  lane: "7",
  loc: "HeadPinz Fort Myers",
  durationMin: 90,
  legStatus: "confirmed",
  ...over,
});

function mkGroup(schedule: ComboScheduleStep[], over: Partial<ComboGroup> = {}): ComboGroup {
  return {
    key: "dep-1",
    comboId: "race-bowl",
    meta: {
      name: "Ultimate VIP Experience",
      accentColor: "#d4af37",
      includes: ["Starter Race", "VIP Bowling", "Intermediate Race"],
      center: "fort-myers",
    },
    legs: [{ status: "confirmed" } as Reservation],
    bowling: undefined,
    races: [],
    anchor: {} as Reservation,
    guestName: "Test Guest",
    playerCount: 4,
    centerCode: "TXBSQN0FEKQ11",
    dayofOrders: [],
    totalCents: 0,
    grossCents: 0,
    schedule,
    inactive: false,
    ...over,
  };
}

describe("detectPendingMoves — karting → bowling", () => {
  it("fires when the race before bowling is finished by track truth", () => {
    const g = mkGroup([race({ raceState: "finished" }), bowling()]);
    const moves = detectPendingMoves([g], at("2026-07-10T20:12:00"));
    expect(moves).toHaveLength(1);
    expect(moves[0].direction).toBe("karting_to_bowling");
    expect(moves[0].to.label).toBe("VIP Bowling");
    expect(moves[0].endingSoon).toBeUndefined();
  });

  it("never fires on a race → race pair (same center)", () => {
    // Fallback ordering: two races then bowling — only the SECOND race's
    // finish is a boundary.
    const g = mkGroup([
      race({ raceState: "finished" }),
      race({ label: "Intermediate Race · Blue", iso: "2026-07-10T20:30:00" }),
      bowling({ iso: "2026-07-10T21:15:00" }),
    ]);
    const moves = detectPendingMoves([g], at("2026-07-10T20:12:00"));
    expect(moves).toHaveLength(0);
  });

  it("suppresses when the bowling lane is already open (arrived)", () => {
    const g = mkGroup([race({ raceState: "finished" }), bowling({ legStatus: "arrived" })]);
    expect(detectPendingMoves([g], at("2026-07-10T20:12:00"))).toHaveLength(0);
  });

  it("clock-only done waits out the grace, then fires", () => {
    const g = mkGroup([race(), bowling()]); // no raceState — clock fallback
    // race end 20:10; inside the 10-min grace → hold
    expect(detectPendingMoves([g], at("2026-07-10T20:15:00"))).toHaveLength(0);
    // past the grace → fire
    expect(detectPendingMoves([g], at("2026-07-10T20:21:00"))).toHaveLength(1);
  });

  it("goes quiet once the finish is stale (45 min)", () => {
    const g = mkGroup([race({ raceState: "finished" }), bowling({ iso: "2026-07-10T22:00:00" })]);
    expect(detectPendingMoves([g], at("2026-07-10T21:00:00"))).toHaveLength(0);
  });

  it("truth-finished fires immediately, no clock grace", () => {
    const g = mkGroup([race({ raceState: "finished" }), bowling()]);
    // 20:05 — before the scheduled 20:10 end, but the session actually ended
    expect(detectPendingMoves([g], at("2026-07-10T20:05:00"))).toHaveLength(1);
  });
});

describe("detectPendingMoves — bowling → karting", () => {
  const finishedBowling = bowling({ legStatus: "completed" });

  it("fires when bowling is completed and a race is next", () => {
    const g = mkGroup([
      race({ raceState: "finished" }),
      finishedBowling,
      race({ label: "Intermediate Race · Blue", iso: "2026-07-10T22:45:00" }),
    ]);
    const moves = detectPendingMoves([g], at("2026-07-10T22:20:00"));
    expect(moves).toHaveLength(1);
    expect(moves[0].direction).toBe("bowling_to_karting");
  });

  it("fires even when the intermediate is pending (time TBD)", () => {
    const g = mkGroup([
      race({ raceState: "finished" }),
      finishedBowling,
      race({ label: "Intermediate Race", iso: null, pending: true, durationMin: 30 }),
    ]);
    const moves = detectPendingMoves([g], at("2026-07-10T22:20:00"));
    expect(moves).toHaveLength(1);
    expect(moves[0].to.iso).toBeNull();
  });

  it("suppresses when the next race is already on track", () => {
    const g = mkGroup([
      finishedBowling,
      race({
        label: "Intermediate Race · Blue",
        iso: "2026-07-10T22:45:00",
        raceState: "on_track",
      }),
    ]);
    expect(detectPendingMoves([g], at("2026-07-10T22:20:00"))).toHaveLength(0);
  });

  it("does NOT suppress when the next race is merely called (hustle over)", () => {
    const g = mkGroup([
      finishedBowling,
      race({ label: "Intermediate Race · Blue", iso: "2026-07-10T22:45:00", raceState: "called" }),
    ]);
    expect(detectPendingMoves([g], at("2026-07-10T22:20:00"))).toHaveLength(1);
  });
});

describe("detectPendingMoves — group-level guards", () => {
  it("skips inactive (retired) combos", () => {
    const g = mkGroup([race({ raceState: "finished" }), bowling()], { inactive: true });
    expect(detectPendingMoves([g], at("2026-07-10T20:12:00"))).toHaveLength(0);
  });

  it("skips all-cancelled combos", () => {
    const g = mkGroup([race({ raceState: "finished" }), bowling()], {
      legs: [{ status: "cancelled" } as Reservation],
    });
    expect(detectPendingMoves([g], at("2026-07-10T20:12:00"))).toHaveLength(0);
  });

  it("skips a boundary whose bowling leg is cancelled", () => {
    const g = mkGroup([race({ raceState: "finished" }), bowling({ legStatus: "cancelled" })]);
    expect(detectPendingMoves([g], at("2026-07-10T20:12:00"))).toHaveLength(0);
  });

  it("combines two parties finishing races at the same time into two moves", () => {
    const a = mkGroup([race({ raceState: "finished" }), bowling()], { key: "dep-a" });
    const b = mkGroup(
      [race({ label: "Starter Race · Red", raceState: "finished" }), bowling({ lane: "5" })],
      { key: "dep-b", guestName: "Second Party" },
    );
    const moves = detectPendingMoves([a, b], at("2026-07-10T20:12:00"));
    expect(moves).toHaveLength(2);
    expect(new Set(moves.map((m) => m.groupKey))).toEqual(new Set(["dep-a", "dep-b"]));
  });
});

describe("detectPendingMoves — 5-min bowling combine window", () => {
  // Party A's lane closed; party B is still bowling with 3 minutes left on
  // the clock; party C has 10 minutes left.
  const nowIso = "2026-07-10T22:18:00";
  const a = mkGroup(
    [
      bowling({ legStatus: "completed" }),
      race({ label: "Intermediate", iso: "2026-07-10T22:45:00" }),
    ],
    { key: "dep-a" },
  );
  const b = mkGroup(
    [
      bowling({ lane: "5", iso: "2026-07-10T20:51:00", legStatus: "arrived" }), // ends 22:21
      race({ label: "Intermediate", iso: "2026-07-10T23:00:00" }),
    ],
    { key: "dep-b", guestName: "Second Party" },
  );
  const c = mkGroup(
    [
      bowling({ lane: "9", iso: "2026-07-10T20:58:00", legStatus: "arrived" }), // ends 22:28
      race({ label: "Intermediate", iso: "2026-07-10T23:15:00" }),
    ],
    { key: "dep-c", guestName: "Third Party" },
  );

  it("sweeps the in-window party into the alert with endingSoon", () => {
    const moves = detectPendingMoves([a, b, c], at(nowIso));
    expect(moves.map((m) => m.groupKey).sort()).toEqual(["dep-a", "dep-b"]);
    const rider = moves.find((m) => m.groupKey === "dep-b");
    expect(rider?.endingSoon?.minsLeft).toBe(3);
    expect(rider?.direction).toBe("bowling_to_karting");
  });

  it("does not alert ending-soon parties on their own (no anchor finish)", () => {
    const moves = detectPendingMoves([b, c], at(nowIso));
    expect(moves).toHaveLength(0);
  });

  it("does not sweep a rider whose next race is already on track", () => {
    const bBusy = mkGroup(
      [
        bowling({ lane: "5", iso: "2026-07-10T20:51:00", legStatus: "arrived" }),
        race({ label: "Intermediate", iso: "2026-07-10T23:00:00", raceState: "on_track" }),
      ],
      { key: "dep-b" },
    );
    const moves = detectPendingMoves([a, bBusy], at(nowIso));
    expect(moves.map((m) => m.groupKey)).toEqual(["dep-a"]);
  });
});

describe("refreshMoves — live-card countdown upkeep", () => {
  const g = mkGroup([
    bowling({ legStatus: "completed" }),
    race({ label: "Intermediate Race · Blue", iso: "2026-07-10T23:36:00" }),
  ]);
  const [move] = detectPendingMoves([g], at("2026-07-10T22:52:00"));

  it("stays unsettled while the countdown runs", () => {
    const r = refreshMoves([move], [g], at("2026-07-10T23:00:00"));
    expect(r.settled).toBe(false);
    expect(r.moves[0].to.iso).toBe("2026-07-10T23:36:00");
  });

  it("settles once the next activity's start passes (countdown reached zero)", () => {
    const r = refreshMoves([move], [g], at("2026-07-10T23:37:00"));
    expect(r.settled).toBe(true);
  });

  it("re-anchors to a shifted schedule (office/manager time change)", () => {
    const shifted = mkGroup([
      bowling({ legStatus: "completed" }),
      race({ label: "Intermediate Race · Blue", iso: "2026-07-10T23:48:00" }),
    ]);
    const r = refreshMoves([move], [shifted], at("2026-07-10T23:40:00"));
    expect(r.moves[0].to.iso).toBe("2026-07-10T23:48:00");
    expect(r.settled).toBe(false);
  });

  it("drops a rider's endingSoon once their lane actually closes", () => {
    const rider = { ...move, endingSoon: { minsLeft: 3 } };
    const r = refreshMoves([rider], [g], at("2026-07-10T23:00:00"));
    expect(r.moves[0].endingSoon).toBeUndefined();
  });
});
