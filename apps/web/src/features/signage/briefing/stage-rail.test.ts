import { describe, expect, it } from "vitest";
import { buildStageRail, STAGE_LABELS, type StageRailInput } from "./stage-rail";
import { EMPTY_PIT_LANE, type PitLaneFeed } from "../pit/pit-board";
import type { BriefingRoomState } from "./types";

/**
 * The rail's whole job is that one session appears once. Everything here is
 * about the two ways that used to break: Pandora holding a called record long
 * after the group has gone racing, and a Mega night where two rooms serve one
 * circuit.
 */

const NOW = 1_700_000_000_000;
const mmss = (ms: number) => {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
};

function room(over: Partial<BriefingRoomState>): BriefingRoomState {
  return {
    kind: "timeline",
    tier: "starter",
    track: "red",
    raceType: "Starter",
    sessionId: "9000",
    heatNumber: 60,
    triggeredAtMs: NOW - 60_000,
    videoUrl: "https://example.test/film.mp4",
    videoDurationMs: 5 * 60_000,
    ...over,
  };
}

function lane(over: Partial<PitLaneFeed>): PitLaneFeed {
  return { ...EMPTY_PIT_LANE, ...over };
}

const BASE: StageRailInput = {
  called: null,
  rooms: [],
  lane: null,
  nowMs: NOW,
  formatClock: mmss,
};

function rowFor(rows: ReturnType<typeof buildStageRail>, label: string) {
  const row = rows.find((r) => r.label === label);
  if (!row) throw new Error(`no ${label} row`);
  return row;
}

describe("buildStageRail", () => {
  it("always returns the six stages in journey order", () => {
    expect(buildStageRail(BASE).map((r) => r.label)).toEqual([...STAGE_LABELS]);
  });

  it("reads every stage as empty when nothing is happening", () => {
    const rows = buildStageRail(BASE);
    expect(rows.every((r) => r.value === "—")).toBe(true);
    expect(rows.every((r) => r.heatNumber === null)).toBe(true);
  });

  it("names the called heat and its level", () => {
    const rows = buildStageRail({
      ...BASE,
      called: { heatNumber: 61, raceType: "Intermediate" },
    });
    expect(rowFor(rows, "Called")).toMatchObject({
      value: "Session 61",
      type: "Intermediate",
      heatNumber: 61,
    });
  });

  it("drops a called heat that has demonstrably moved on", () => {
    // Pandora keeps the call for ~20 minutes; the lane says they are racing.
    const rows = buildStageRail({
      ...BASE,
      called: { heatNumber: 59, raceType: "Junior Starter" },
      lane: lane({ racing: { sessionId: "8900", heatNumber: 59, raceType: "Junior Starter" } }),
    });
    expect(rowFor(rows, "Called").value).toBe("—");
    expect(rowFor(rows, "On track").value).toBe("Session 59");
  });

  it("drops a called heat that is already in a briefing room", () => {
    const rows = buildStageRail({
      ...BASE,
      called: { heatNumber: 60, raceType: "Starter" },
      rooms: [room({ heatNumber: 60 })],
    });
    expect(rowFor(rows, "Called").value).toBe("—");
    expect(rowFor(rows, "Briefing").value).toBe("Session 60");
  });

  it("does not drop a called heat because an IDLE room still names it", () => {
    // A timed-out assignment is not an occupancy — the group never went, and the
    // heat is still waiting at the desk.
    const rows = buildStageRail({
      ...BASE,
      called: { heatNumber: 60, raceType: "Starter" },
      rooms: [room({ kind: "assigned", triggeredAtMs: NOW - 10 * 60 * 60_000 })],
    });
    expect(rowFor(rows, "Called").value).toBe("Session 60");
    expect(rowFor(rows, "Briefing").value).toBe("—");
  });

  it("takes whichever of two Mega rooms holds a live timeline", () => {
    const rows = buildStageRail({
      ...BASE,
      rooms: [
        room({ kind: "assigned", triggeredAtMs: NOW - 10 * 60 * 60_000, heatNumber: 58 }),
        room({ heatNumber: 62, raceType: "Mega", track: "mega" }),
      ],
    });
    expect(rowFor(rows, "Briefing")).toMatchObject({ value: "Session 62", type: "Mega" });
  });

  it("counts the film down in whole minutes, never below one", () => {
    const rows = buildStageRail({
      ...BASE,
      rooms: [room({ triggeredAtMs: NOW - (5 * 60_000 - 10_000) })],
    });
    expect(rowFor(rows, "Briefing").detail).toBe("1 min of film left");
  });

  it("says the helmets are up once the film has run out", () => {
    const rows = buildStageRail({ ...BASE, rooms: [room({ triggeredAtMs: NOW - 6 * 60_000 })] });
    expect(rowFor(rows, "Briefing")).toMatchObject({
      detail: "helmets — ready to send",
      tone: "good",
    });
  });

  it("clocks the seats and the pit from their own stamps", () => {
    const rows = buildStageRail({
      ...BASE,
      lane: lane({
        holding: {
          sessionId: "9100",
          heatNumber: 61,
          raceType: "Intermediate",
          room: "red",
          atMs: NOW - 108_000,
        },
        pitIn: {
          sessionId: "8900",
          heatNumber: 59,
          raceType: "Junior Starter",
          room: "red",
          finishedAtMs: NOW - 80_000,
          atMs: NOW - 80_000,
          postRaceAtMs: null,
          postRaceDurationS: null,
        },
      }),
    });
    expect(rowFor(rows, "Holding").detail).toBe("in the seats · 1:48");
    expect(rowFor(rows, "Pit in")).toMatchObject({
      detail: "karts in — post-race owed · 1:20",
      tone: "alert",
    });
  });

  it("prints no seat clock when the stamp is in our future — a skew is not an arrival", () => {
    const rows = buildStageRail({
      ...BASE,
      lane: lane({
        holding: {
          sessionId: "9100",
          heatNumber: 61,
          raceType: null,
          room: "red",
          atMs: NOW + 30_000,
        },
      }),
    });
    expect(rowFor(rows, "Holding").detail).toBe("in the seats");
  });

  it("falls back to the timing feed for the on-track heat but never for its level", () => {
    const rows = buildStageRail({
      ...BASE,
      liveHeatNumber: 59,
      liveCounting: true,
      liveRemainingMs: 384_000,
    });
    expect(rowFor(rows, "On track")).toMatchObject({
      value: "Session 59",
      type: undefined,
      detail: "6:24 left · racing",
    });
  });

  it("keeps the lane's level when the lane has one", () => {
    const rows = buildStageRail({
      ...BASE,
      lane: lane({ racing: { sessionId: "8900", heatNumber: 59, raceType: "Junior Starter" } }),
      liveHeatNumber: 59,
      liveCounting: true,
      liveRemainingMs: 384_000,
    });
    expect(rowFor(rows, "On track").type).toBe("Junior Starter");
  });

  it("says the track is clear only when nothing is out", () => {
    expect(rowFor(buildStageRail(BASE), "On track").detail).toBe("track clear");
    const busy = buildStageRail({ ...BASE, liveHeatNumber: 59, liveCounting: true });
    expect(rowFor(busy, "On track").detail).toBe("racing");
  });

  it("reads the desk count onto the called row, and 0 of 0 as no count at all", () => {
    const short = buildStageRail({
      ...BASE,
      called: { heatNumber: 61, raceType: "Intermediate" },
      checkedIn: { checkedIn: 9, total: 12 },
    });
    expect(rowFor(short, "Called")).toMatchObject({ detail: "9 of 12 checked in", tone: "warn" });

    const full = buildStageRail({
      ...BASE,
      called: { heatNumber: 61, raceType: "Intermediate" },
      checkedIn: { checkedIn: 12, total: 12 },
    });
    expect(rowFor(full, "Called")).toMatchObject({ detail: "12 of 12 checked in", tone: "good" });

    const unread = buildStageRail({
      ...BASE,
      called: { heatNumber: 61, raceType: "Intermediate" },
      checkedIn: { checkedIn: 0, total: 0 },
    });
    expect(rowFor(unread, "Called")).toMatchObject({ detail: undefined, tone: "none" });
  });

  it("reads exactly as the wall always has when no extras are supplied", () => {
    // The TV passes no clock formatter and no desk count; every row must fall
    // back to the sentences ScenePitBoard has always shown.
    const rows = buildStageRail({
      called: { heatNumber: 61, raceType: "Intermediate" },
      rooms: [],
      nowMs: NOW,
      lane: lane({
        holding: {
          sessionId: "9100",
          heatNumber: 61,
          raceType: "Intermediate",
          room: "red",
          atMs: NOW - 60_000,
        },
        karts: {
          sessionId: "9000",
          heatNumber: 60,
          raceType: "Starter",
          room: "red",
          atMs: NOW - 30_000,
          preRaceAtMs: null,
          preRaceDurationS: null,
        },
      }),
    });
    expect(rowFor(rows, "Holding").detail).toBe("in the seats");
    expect(rowFor(rows, "In karts").detail).toBe("seated — waiting on the green");
  });
});
