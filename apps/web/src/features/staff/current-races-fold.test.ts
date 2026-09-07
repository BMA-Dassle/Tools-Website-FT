import { describe, expect, it } from "vitest";
import {
  foldCurrentRaces,
  laneOccupancies,
  roomOccupancies,
  STAGE_RANK,
  type RaceOccupancy,
} from "./current-races-fold";
import { EMPTY_PIT_LANE, type PitLaneFeed, type PitLanes } from "../signage/pit/pit-board";
import type { BriefingRoomState } from "../signage/briefing/types";

/**
 * Two rules carry this module and both are counter-intuitive enough to be worth
 * pinning: a person holding two groups is named for the FURTHEST ALONG, and
 * "furthest along" puts a group in the pit at the BOTTOM rather than the top.
 */

const NOW = 1_700_000_000_000;

function lane(over: Partial<PitLaneFeed>): PitLaneFeed {
  return { ...EMPTY_PIT_LANE, ...over };
}

function lanes(over: Partial<PitLanes>): PitLanes {
  return { blue: EMPTY_PIT_LANE, red: EMPTY_PIT_LANE, mega: EMPTY_PIT_LANE, ...over };
}

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

const occ = (over: Partial<RaceOccupancy>): RaceOccupancy => ({
  sessionId: "1",
  track: "blue",
  heatNumber: 34,
  stage: "racing",
  ...over,
});

const HOSTS = {
  "1": { userId: 10, firstName: "Pedro" },
  "2": { userId: 11, firstName: "Ivan" },
  "3": { userId: 10, firstName: "Pedro" },
};

describe("STAGE_RANK", () => {
  it("ranks live stages above staged ones, and pit-in below everything", () => {
    expect(STAGE_RANK.racing).toBeGreaterThan(STAGE_RANK.karts);
    expect(STAGE_RANK.karts).toBeGreaterThan(STAGE_RANK.holding);
    expect(STAGE_RANK.holding).toBeGreaterThan(STAGE_RANK.briefing);
    // The one that reads backwards until you know why — see the module header.
    expect(STAGE_RANK.briefing).toBeGreaterThan(STAGE_RANK.pitIn);
  });
});

describe("laneOccupancies", () => {
  it("reads every occupied slot on every track", () => {
    const out = laneOccupancies(
      lanes({
        blue: lane({
          holding: {
            sessionId: "a",
            heatNumber: 35,
            raceType: "Starter",
            room: "blue",
            atMs: NOW,
          },
          racing: { sessionId: "b", heatNumber: 34, raceType: "Starter", room: "blue" },
        }),
        mega: lane({
          pitIn: {
            sessionId: "c",
            heatNumber: 12,
            raceType: "Pro",
            room: "red",
            atMs: NOW,
            finishedAtMs: NOW,
            postRaceAtMs: null,
            postRaceDurationS: null,
          },
        }),
      }),
    );
    expect(out).toEqual([
      { sessionId: "a", track: "blue", heatNumber: 35, stage: "holding" },
      { sessionId: "b", track: "blue", heatNumber: 34, stage: "racing" },
      { sessionId: "c", track: "mega", heatNumber: 12, stage: "pitIn" },
    ]);
  });

  it("is empty for an idle floor, and for no lanes at all", () => {
    expect(laneOccupancies(lanes({}))).toEqual([]);
    expect(laneOccupancies(null)).toEqual([]);
  });
});

describe("roomOccupancies", () => {
  it("takes the track from the room's state, not from the room's name", () => {
    // A Mega night: the RED room is briefing into the one circuit.
    const out = roomOccupancies({ red: room({ track: "mega", heatNumber: 12 }), blue: null }, NOW);
    expect(out).toEqual([{ sessionId: "9000", track: "mega", heatNumber: 12, stage: "briefing" }]);
  });

  it("still counts a room on the helmet board — they are being kitted, and they are still that marshal's group", () => {
    // The helmet phase has no end on a clock (briefing/phase.ts): the room's
    // occupants leave on a press, not a timer, so their marshal keeps the tag.
    const kitting = room({ triggeredAtMs: NOW - 10 * 60_000 });
    expect(roomOccupancies({ red: kitting, blue: null }, NOW)).toHaveLength(1);
  });

  it("ignores an abandoned send once the assigned hold lapses", () => {
    const abandoned = room({ kind: "assigned", triggeredAtMs: NOW - 60 * 60_000 });
    expect(roomOccupancies({ red: abandoned, blue: null }, NOW)).toEqual([]);
    // ...but a fresh one counts.
    const justSent = room({ kind: "assigned", triggeredAtMs: NOW - 30_000 });
    expect(roomOccupancies({ red: justSent, blue: null }, NOW)).toHaveLength(1);
  });

  it("is empty for no rooms", () => {
    expect(roomOccupancies(null, NOW)).toEqual([]);
    expect(roomOccupancies({ red: null, blue: null }, NOW)).toEqual([]);
  });
});

describe("foldCurrentRaces", () => {
  it("names one person once, for the group furthest along", () => {
    const out = foldCurrentRaces(
      [
        occ({ sessionId: "3", stage: "briefing", heatNumber: 36, track: "red" }),
        occ({ sessionId: "1", stage: "karts", heatNumber: 35 }),
      ],
      HOSTS,
    );
    expect(out).toEqual([
      {
        userId: 10,
        firstName: "Pedro",
        sessionId: "1",
        track: "blue",
        heatNumber: 35,
        stage: "karts",
      },
    ]);
  });

  it("prefers a briefing over a group that has already pitted in", () => {
    const out = foldCurrentRaces(
      [
        occ({ sessionId: "1", stage: "pitIn", heatNumber: 34 }),
        occ({ sessionId: "3", stage: "briefing", heatNumber: 36, track: "red" }),
      ],
      HOSTS,
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ heatNumber: 36, stage: "briefing", track: "red" });
  });

  it("does not care what order the occupancies arrive in", () => {
    const a = foldCurrentRaces(
      [occ({ sessionId: "1", stage: "racing" }), occ({ sessionId: "3", stage: "holding" })],
      HOSTS,
    );
    const b = foldCurrentRaces(
      [occ({ sessionId: "3", stage: "holding" }), occ({ sessionId: "1", stage: "racing" })],
      HOSTS,
    );
    expect(a).toEqual(b);
    expect(a[0].stage).toBe("racing");
  });

  it("keeps an unknown heat number as null rather than inventing one", () => {
    const out = foldCurrentRaces([occ({ sessionId: "1", heatNumber: null })], HOSTS);
    expect(out[0].heatNumber).toBeNull();
  });

  it("drops an occupancy nobody claimed", () => {
    const out = foldCurrentRaces([occ({ sessionId: "nobody" }), occ({ sessionId: "2" })], HOSTS);
    expect(out.map((r) => r.firstName)).toEqual(["Ivan"]);
  });

  it("lists two people on two tracks, most advanced first", () => {
    const out = foldCurrentRaces(
      [
        occ({ sessionId: "2", stage: "briefing", track: "red", heatNumber: 33 }),
        occ({ sessionId: "1", stage: "racing", track: "blue", heatNumber: 35 }),
      ],
      HOSTS,
    );
    expect(out.map((r) => [r.firstName, r.stage])).toEqual([
      ["Pedro", "racing"],
      ["Ivan", "briefing"],
    ]);
  });

  it("is empty when nothing is out", () => {
    expect(foldCurrentRaces([], HOSTS)).toEqual([]);
  });
});
