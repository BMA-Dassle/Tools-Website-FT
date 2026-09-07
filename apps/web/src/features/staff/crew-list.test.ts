import { describe, expect, it } from "vitest";
import {
  buildCrewBoard,
  buildCrewList,
  crewState,
  raceTagLabel,
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
        briefedByStaff: [{ userId: 99, firstName: "Ghost", briefed: 9 }],
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
        briefedByStaff: [{ userId: 99, firstName: "Ghost", briefed: 9 }],
        currentRaces: [race({ userId: 2, firstName: "Pedro" })],
      }),
    );
    expect(names(list)).toEqual(["Pedro"]);
  });

  it("drops a person nothing can name", () => {
    const list = buildCrewList(
      input({ briefedByStaff: [{ userId: 1, firstName: null, briefed: 4 }] }),
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

  it("breaks a state tie on the count, then on the name", () => {
    const list = buildCrewList(
      input({
        onShiftTrackOps: [
          holder({ userId: 1, firstName: "Bea" }),
          holder({ userId: 2, firstName: "Al" }),
          holder({ userId: 3, firstName: "Cy" }),
        ],
        briefedByStaff: [
          { userId: 1, firstName: "Bea", briefed: 7 },
          { userId: 2, firstName: "Al", briefed: 1 },
          { userId: 3, firstName: "Cy", briefed: 1 },
        ],
      }),
    );
    expect(names(list)).toEqual(["Bea", "Al", "Cy"]);
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
          { userId: 1, firstName: "Ivan", briefed: 7 },
          { userId: 2, firstName: "Pedro", briefed: 9 },
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
        briefedByStaff: [{ userId: 1, firstName: "FromBriefing", briefed: 2 }],
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
        { userId: 1, firstName: "Al", briefed: 3 },
        { userId: 2, firstName: "Bea", briefed: 3 },
      ],
    });
    expect(buildCrewList(args)).toEqual(buildCrewList(args));
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
          { userId: 1, firstName: "Ivan", briefed: 7 },
          { userId: 2, firstName: "Pedro", briefed: 9 },
          { userId: 3, firstName: "Gone", briefed: 4 },
          { userId: 4, firstName: "AlsoGone", briefed: 2 },
        ],
        onShiftTrackOps: [
          holder({ userId: 1, firstName: "Ivan" }),
          holder({ userId: 2, firstName: "Pedro" }),
        ],
        unattributed: 2,
      }),
    );
    expect(names(board.list)).toEqual(["Pedro", "Ivan"]);
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
      input({ briefedByStaff: [{ userId: 1, firstName: "Ivan", briefed: 0 }] }),
    );
    expect(board.briefers).toBe(0);
    expect(board.groups).toBe(0);
  });
});
