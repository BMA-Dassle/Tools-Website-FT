import { describe, expect, it } from "vitest";
import {
  buildCrewBoard,
  buildCrewList,
  crewState,
  formatIdle,
  nextUp,
  raceTagLabel,
  type BriefedCount,
  type CrewInput,
} from "./crew-list";
import type { StaffRace } from "./current-races-fold";
import type { TrackOpsHolder } from "./portal-roster";

/**
 * The rules this pins are the ones a reader would otherwise have to take on
 * trust: who is ON the list at all, who drops off it at the end of a shift, and
 * why somebody on their break is not "available" even when they are standing in
 * the pit lane.
 */

/** A fixed "now", so every idle assertion is arithmetic rather than a race. */
const NOW = Date.UTC(2026, 8, 10, 23, 0, 0);
/** Minutes before NOW, as an epoch — the shape a `pitted` stamp arrives in. */
const freeFor = (minutes: number) => NOW - minutes * 60_000;

const holder = (over: Partial<TrackOpsHolder> & { userId: number }): TrackOpsHolder => ({
  firstName: `U${over.userId}`,
  presence: "in",
  hasPunchedToday: true,
  ...over,
});

const race = (over: Partial<StaffRace> & { userId: number }): StaffRace => ({
  firstName: `U${over.userId}`,
  sessionId: String(over.userId),
  track: "blue",
  heatNumber: 35,
  stage: "racing",
  ...over,
});

/** One row of the counts query. `freeSinceMs` defaults to "no stamp", which is
 *  what a person who has not taken a group tonight actually has. */
const brief = (over: Partial<BriefedCount> & { userId: number }): BriefedCount => ({
  firstName: `U${over.userId}`,
  briefed: 0,
  freeSinceMs: null,
  ...over,
});

const input = (over: Partial<CrewInput>): CrewInput => ({
  briefedByStaff: [],
  currentRaces: [],
  onShiftTrackOps: [],
  unattributed: 0,
  ...over,
});

const names = (list: ReturnType<typeof buildCrewList>) => list.map((e) => e.firstName);

describe("crewState", () => {
  it("is available when clocked in and hosting nothing", () => {
    expect(crewState({ presence: "in", hasPunchedToday: true, hosting: false })).toBe("available");
  });

  it("is assigned when hosting, on Track Ops or not", () => {
    expect(crewState({ presence: "in", hasPunchedToday: true, hosting: true })).toBe("assigned");
    expect(crewState({ presence: null, hasPunchedToday: false, hosting: true })).toBe("assigned");
  });

  it("puts a break ahead of everything — a break is not availability", () => {
    expect(crewState({ presence: "break", hasPunchedToday: true, hosting: false })).toBe("break");
    // ...and still a break when they are holding a group. The tag survives; the
    // state does not become "assigned".
    expect(crewState({ presence: "break", hasPunchedToday: true, hosting: true })).toBe("break");
  });

  it("is not-in for somebody rostered who has not punched", () => {
    expect(crewState({ presence: "out", hasPunchedToday: false, hosting: false })).toBe("not-in");
  });
});

describe("buildCrewList — membership", () => {
  it("lists the portal's Track Ops crew plus anyone hosting, and nobody else", () => {
    const list = buildCrewList(
      input({
        // Briefed nine groups this afternoon, off Track Ops, hosting nothing.
        briefedByStaff: [brief({ userId: 99, firstName: "Ghost", briefed: 9 })],
        onShiftTrackOps: [holder({ userId: 1, firstName: "Ivan" })],
        currentRaces: [race({ userId: 2, firstName: "Pedro" })],
      }),
    );
    expect(names(list).sort()).toEqual(["Ivan", "Pedro"]);
  });

  it("drops somebody who has clocked out for the day", () => {
    const list = buildCrewList(
      input({
        onShiftTrackOps: [
          holder({ userId: 1, firstName: "Ivan" }),
          holder({ userId: 2, firstName: "Gone", presence: "out", hasPunchedToday: true }),
        ],
      }),
    );
    expect(names(list)).toEqual(["Ivan"]);
  });

  it("keeps a clocked-out person who is still running a group", () => {
    const list = buildCrewList(
      input({
        onShiftTrackOps: [
          holder({ userId: 2, firstName: "Gone", presence: "out", hasPunchedToday: true }),
        ],
        currentRaces: [race({ userId: 2, firstName: "Gone", heatNumber: 34 })],
      }),
    );
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ firstName: "Gone", state: "assigned" });
  });

  it("keeps somebody rostered who has not punched in yet", () => {
    const list = buildCrewList(
      input({
        onShiftTrackOps: [
          holder({ userId: 3, firstName: "Later", presence: "out", hasPunchedToday: false }),
        ],
      }),
    );
    expect(list).toEqual([
      expect.objectContaining({ firstName: "Later", state: "not-in", briefed: 0 }),
    ]);
  });

  it("counts somebody rostered on both Track Ops and the floaters once", () => {
    // The roster module de-dupes, but the fold must not double them either.
    const list = buildCrewList(
      input({ onShiftTrackOps: [holder({ userId: 1 }), holder({ userId: 1 })] }),
    );
    expect(list).toHaveLength(1);
  });

  it("shows only the race hosts when there is no roster at all", () => {
    const list = buildCrewList(
      input({
        onShiftTrackOps: null,
        briefedByStaff: [brief({ userId: 99, firstName: "Ghost", briefed: 9 })],
        currentRaces: [race({ userId: 2, firstName: "Pedro" })],
      }),
    );
    expect(names(list)).toEqual(["Pedro"]);
  });

  it("drops a person nothing can name", () => {
    const list = buildCrewList(
      input({ briefedByStaff: [brief({ userId: 1, firstName: null, briefed: 4 })] }),
    );
    expect(list).toEqual([]);
  });
});

describe("buildCrewList — state, order and tags", () => {
  it("orders available, then assigned, then break, then not-in", () => {
    const list = buildCrewList(
      input({
        onShiftTrackOps: [
          holder({ userId: 1, firstName: "Avail" }),
          holder({ userId: 2, firstName: "Busy" }),
          holder({ userId: 3, firstName: "Break", presence: "break" }),
          holder({ userId: 4, firstName: "Later", presence: "out", hasPunchedToday: false }),
        ],
        currentRaces: [race({ userId: 2, firstName: "Busy" })],
      }),
    );
    expect(names(list)).toEqual(["Avail", "Busy", "Break", "Later"]);
    expect(list.map((e) => e.state)).toEqual(["available", "assigned", "break", "not-in"]);
  });

  /**
   * THE QUEUE RULE (owner 2026-09-10). These four replace a single test that
   * pinned the opposite — "breaks a state tie on the count" — which is exactly
   * the behaviour that put the marshal with 17 groups at the front of the
   * strip all night on 09-09 while somebody with 2 stood next to them.
   */
  it("breaks a state tie on who has been free longest, then on the name", () => {
    const list = buildCrewList(
      input({
        onShiftTrackOps: [
          holder({ userId: 1, firstName: "Bea" }),
          holder({ userId: 2, firstName: "Al" }),
          holder({ userId: 3, firstName: "Cy" }),
        ],
        briefedByStaff: [
          brief({ userId: 1, firstName: "Bea", briefed: 7, freeSinceMs: freeFor(4) }),
          brief({ userId: 2, firstName: "Al", briefed: 1, freeSinceMs: freeFor(40) }),
          brief({ userId: 3, firstName: "Cy", briefed: 1, freeSinceMs: freeFor(22) }),
        ],
      }),
    );
    expect(names(list)).toEqual(["Al", "Cy", "Bea"]);
  });

  it("puts the busiest marshal LAST when they have just come in", () => {
    // The 09-09 shape: 17 groups against 2. The person who has run the night
    // has also only just parked, so they are the one who waits.
    const list = buildCrewList(
      input({
        onShiftTrackOps: [
          holder({ userId: 1, firstName: "Dayanara" }),
          holder({ userId: 2, firstName: "Pedro" }),
        ],
        briefedByStaff: [
          brief({ userId: 1, firstName: "Dayanara", briefed: 17, freeSinceMs: freeFor(3) }),
          brief({ userId: 2, firstName: "Pedro", briefed: 2, freeSinceMs: freeFor(55) }),
        ],
      }),
    );
    expect(names(list)).toEqual(["Pedro", "Dayanara"]);
    // The count still rides along, and still marks the top briefer — it just
    // no longer decides who goes next.
    expect(list.map((e) => e.briefed)).toEqual([2, 17]);
    expect(list.filter((e) => e.top).map((e) => e.firstName)).toEqual(["Dayanara"]);
  });

  it("leads with somebody who has not taken a group tonight, and gives them no clock", () => {
    const list = buildCrewList(
      input({
        onShiftTrackOps: [
          holder({ userId: 1, firstName: "Pedro" }),
          holder({ userId: 2, firstName: "Roisel" }),
        ],
        // Roisel is not in the counts at all — nothing to stamp.
        briefedByStaff: [
          brief({ userId: 1, firstName: "Pedro", briefed: 1, freeSinceMs: freeFor(90) }),
        ],
      }),
    );
    expect(names(list)).toEqual(["Roisel", "Pedro"]);
    expect(list[0].freeSinceMs).toBeNull();
    expect(formatIdle(list[0].freeSinceMs, NOW)).toBeNull();
  });

  it("treats a missed Race-returned press the same way, rather than skipping them", () => {
    // Briefed a group, but no `pitted` stamp came back for it (2-3% of groups).
    // Indistinguishable from "has not gone out", and handled identically: they
    // go to the front, because erring towards giving somebody a group is the
    // safe direction.
    const list = buildCrewList(
      input({
        onShiftTrackOps: [
          holder({ userId: 1, firstName: "Denys" }),
          holder({ userId: 2, firstName: "Caleb" }),
        ],
        briefedByStaff: [
          brief({ userId: 1, firstName: "Denys", briefed: 4, freeSinceMs: freeFor(12) }),
          brief({ userId: 2, firstName: "Caleb", briefed: 3, freeSinceMs: null }),
        ],
      }),
    );
    expect(names(list)).toEqual(["Caleb", "Denys"]);
  });

  it("stays a consistent order when nobody has a stamp at all", () => {
    // Two nulls must compare equal and fall through to the name. The `0`
    // sentinel is what makes that true — `-Infinity - -Infinity` is NaN, and a
    // NaN comparator reshuffles the strip differently on every poll.
    const args = input({
      onShiftTrackOps: [
        holder({ userId: 1, firstName: "Cy" }),
        holder({ userId: 2, firstName: "Al" }),
        holder({ userId: 3, firstName: "Bea" }),
      ],
    });
    expect(names(buildCrewList(args))).toEqual(["Al", "Bea", "Cy"]);
    expect(buildCrewList(args)).toEqual(buildCrewList(args));
  });

  it("keeps state ahead of the clock — a busy marshal never outranks a free one", () => {
    // Whoever is out on a group has been "free" longest by the raw number,
    // because their stamp is from the group BEFORE this one. State first is
    // what stops that reading as "send them".
    const list = buildCrewList(
      input({
        onShiftTrackOps: [
          holder({ userId: 1, firstName: "Busy" }),
          holder({ userId: 2, firstName: "Free" }),
        ],
        briefedByStaff: [
          brief({ userId: 1, firstName: "Busy", briefed: 5, freeSinceMs: freeFor(120) }),
          brief({ userId: 2, firstName: "Free", briefed: 1, freeSinceMs: freeFor(3) }),
        ],
        currentRaces: [race({ userId: 1, firstName: "Busy" })],
      }),
    );
    expect(names(list)).toEqual(["Free", "Busy"]);
  });

  it("keeps the tag on somebody who took a break mid-group", () => {
    const list = buildCrewList(
      input({
        onShiftTrackOps: [holder({ userId: 2, firstName: "Joel", presence: "break" })],
        currentRaces: [race({ userId: 2, firstName: "Joel", track: "red", heatNumber: 33 })],
      }),
    );
    expect(list[0].state).toBe("break");
    expect(list[0].race).toEqual({ track: "red", heatNumber: 33 });
  });

  it("shows a roster person with no briefings at zero, not hidden", () => {
    const list = buildCrewList(
      input({ onShiftTrackOps: [holder({ userId: 1, firstName: "Colton" })] }),
    );
    expect(list[0]).toMatchObject({ firstName: "Colton", briefed: 0, state: "available" });
  });

  it("marks the top briefer exactly once, and never at zero", () => {
    const list = buildCrewList(
      input({
        onShiftTrackOps: [
          holder({ userId: 1, firstName: "Ivan" }),
          holder({ userId: 2, firstName: "Pedro" }),
        ],
        briefedByStaff: [
          brief({ userId: 1, firstName: "Ivan", briefed: 7 }),
          brief({ userId: 2, firstName: "Pedro", briefed: 9 }),
        ],
        currentRaces: [race({ userId: 2, firstName: "Pedro" })],
      }),
    );
    expect(list.filter((e) => e.top).map((e) => e.firstName)).toEqual(["Pedro"]);

    const quiet = buildCrewList(input({ onShiftTrackOps: [holder({ userId: 1 })] }));
    expect(quiet.some((e) => e.top)).toBe(false);
  });

  it("prefers the briefing row's name, then the host's, then the roster's", () => {
    const list = buildCrewList(
      input({
        briefedByStaff: [brief({ userId: 1, firstName: "FromBriefing", briefed: 2 })],
        currentRaces: [race({ userId: 1, firstName: "FromHost" })],
        onShiftTrackOps: [holder({ userId: 1, firstName: "FromRoster" })],
      }),
    );
    expect(list[0].firstName).toBe("FromBriefing");
  });

  it("is stable between polls", () => {
    const args = input({
      onShiftTrackOps: [
        holder({ userId: 1, firstName: "Al" }),
        holder({ userId: 2, firstName: "Bea" }),
      ],
      briefedByStaff: [
        brief({ userId: 1, firstName: "Al", briefed: 3 }),
        brief({ userId: 2, firstName: "Bea", briefed: 3 }),
      ],
    });
    expect(buildCrewList(args)).toEqual(buildCrewList(args));
  });
});

describe("formatIdle", () => {
  it("counts whole minutes", () => {
    expect(formatIdle(freeFor(0), NOW)).toBe("0m");
    expect(formatIdle(freeFor(1), NOW)).toBe("1m");
    expect(formatIdle(freeFor(38), NOW)).toBe("38m");
    expect(formatIdle(freeFor(59), NOW)).toBe("59m");
  });

  it("rolls into hours, and drops a zero remainder", () => {
    expect(formatIdle(freeFor(60), NOW)).toBe("1h");
    expect(formatIdle(freeFor(72), NOW)).toBe("1h 12m");
    expect(formatIdle(freeFor(120), NOW)).toBe("2h");
    expect(formatIdle(freeFor(185), NOW)).toBe("3h 5m");
  });

  it("floors rather than rounds — 59 seconds is not a minute yet", () => {
    expect(formatIdle(NOW - 59_000, NOW)).toBe("0m");
    expect(formatIdle(NOW - 61_000, NOW)).toBe("1m");
  });

  it("clamps a stamp from the future to zero", () => {
    // Neon and a wall player do not share a clock to the second, and
    // "-1m since their last group" is how a board loses its audience.
    expect(formatIdle(NOW + 90_000, NOW)).toBe("0m");
  });

  it("has nothing to print without a stamp", () => {
    expect(formatIdle(null, NOW)).toBeNull();
  });
});

describe("nextUp", () => {
  const board = (over: Partial<CrewInput> = {}) =>
    buildCrewList(
      input({
        onShiftTrackOps: [
          holder({ userId: 1, firstName: "Pedro" }),
          holder({ userId: 2, firstName: "Roisel" }),
          holder({ userId: 3, firstName: "Matthew" }),
          holder({ userId: 4, firstName: "Joel", presence: "break" }),
          holder({ userId: 5, firstName: "Later", presence: "out", hasPunchedToday: false }),
        ],
        briefedByStaff: [
          brief({ userId: 1, firstName: "Pedro", briefed: 1, freeSinceMs: freeFor(38) }),
          brief({ userId: 3, firstName: "Matthew", briefed: 4, freeSinceMs: freeFor(9) }),
        ],
        currentRaces: [race({ userId: 3, firstName: "Matthew" })],
        ...over,
      }),
    );

  it("names the longest-waiting free marshal, and queues the rest behind them", () => {
    const { next, queued } = nextUp(board());
    // Roisel has no stamp at all, so she leads; Pedro is the only other free
    // one. Matthew is out on a group, Joel is on a break, Later has not
    // arrived — none of them can be sent anywhere.
    expect(next?.firstName).toBe("Roisel");
    expect(queued.map((e) => e.firstName)).toEqual(["Pedro"]);
  });

  it("agrees with the pill order it is drawn beside", () => {
    const list = board();
    const { next, queued } = nextUp(list);
    expect([next, ...queued].filter(Boolean)).toEqual(list.filter((e) => e.state === "available"));
  });

  it("says nobody rather than naming somebody who cannot be sent", () => {
    const busy = buildCrewList(
      input({
        onShiftTrackOps: [
          holder({ userId: 1, firstName: "Matthew" }),
          holder({ userId: 2, firstName: "Joel", presence: "break" }),
        ],
        currentRaces: [race({ userId: 1, firstName: "Matthew" })],
      }),
    );
    expect(nextUp(busy)).toEqual({ next: null, queued: [] });
    expect(nextUp([])).toEqual({ next: null, queued: [] });
  });

  it("reports an empty queue behind a single free marshal", () => {
    const one = buildCrewList(
      input({ onShiftTrackOps: [holder({ userId: 1, firstName: "Roisel" })] }),
    );
    const { next, queued } = nextUp(one);
    expect(next?.firstName).toBe("Roisel");
    expect(queued).toEqual([]);
  });
});

describe("raceTagLabel", () => {
  it("is the track letter plus the heat", () => {
    expect(raceTagLabel({ track: "blue", heatNumber: 35 })).toBe("B35");
    expect(raceTagLabel({ track: "red", heatNumber: 33 })).toBe("R33");
    expect(raceTagLabel({ track: "mega", heatNumber: 12 })).toBe("M12");
  });

  it("is the letter alone when the heat has no number", () => {
    expect(raceTagLabel({ track: "blue", heatNumber: null })).toBe("B");
  });
});

describe("buildCrewBoard", () => {
  it("counts the DAY in the totals, not the list", () => {
    const board = buildCrewBoard(
      input({
        // Four briefers; two of them have gone home.
        briefedByStaff: [
          brief({ userId: 1, firstName: "Ivan", briefed: 7, freeSinceMs: freeFor(30) }),
          brief({ userId: 2, firstName: "Pedro", briefed: 9, freeSinceMs: freeFor(6) }),
          brief({ userId: 3, firstName: "Gone", briefed: 4, freeSinceMs: freeFor(200) }),
          brief({ userId: 4, firstName: "AlsoGone", briefed: 2, freeSinceMs: freeFor(240) }),
        ],
        onShiftTrackOps: [
          holder({ userId: 1, firstName: "Ivan" }),
          holder({ userId: 2, firstName: "Pedro" }),
        ],
        unattributed: 2,
      }),
    );
    // Ivan first: idle half an hour against Pedro's six minutes. Pedro briefed
    // MORE, which used to put him at the front and no longer does.
    expect(names(board.list)).toEqual(["Ivan", "Pedro"]);
    expect(board).toMatchObject({
      groups: 24,
      briefers: 4,
      unattributed: 2,
      rosterAvailable: true,
    });
  });

  it("reports the roster as unavailable when the portal could not be read", () => {
    expect(buildCrewBoard(input({ onShiftTrackOps: null })).rosterAvailable).toBe(false);
    expect(buildCrewBoard(input({ onShiftTrackOps: [] })).rosterAvailable).toBe(true);
  });

  it("does not count a briefer with zero groups", () => {
    const board = buildCrewBoard(
      input({ briefedByStaff: [brief({ userId: 1, firstName: "Ivan", briefed: 0 })] }),
    );
    expect(board.briefers).toBe(0);
    expect(board.groups).toBe(0);
  });
});
