import { describe, expect, it } from "vitest";
import { laneReturnRoom, lastRoomUsed, suggestMegaRoom } from "./room-suggest";
import { EMPTY_PIT_LANE, type PitLaneFeed } from "../pit/pit-board";

/**
 * The night this file exists for: session 28 out on track, briefed in Red, both
 * rooms idle behind them — and the desk suggested RED, the one room 28 was
 * walking back into.
 */
const NOW = 1_700_000_000_000;

function lane(over: Partial<PitLaneFeed>): PitLaneFeed {
  return { ...EMPTY_PIT_LANE, ...over };
}

const holding = (room: "red" | "blue") => ({
  sessionId: "9300",
  heatNumber: 31,
  raceType: "Pro",
  room,
  atMs: NOW - 60_000,
});

const karts = (room: "red" | "blue") => ({
  sessionId: "9200",
  heatNumber: 30,
  raceType: "Pro",
  room,
  atMs: NOW - 90_000,
  preRaceAtMs: null,
  preRaceDurationS: null,
});

const racing = (room: "red" | "blue" | null) => ({
  sessionId: "9100",
  heatNumber: 28,
  raceType: "Pro",
  room,
});

const pitIn = (room: "red" | "blue") => ({
  sessionId: "9000",
  heatNumber: 27,
  raceType: "Starter",
  room,
  finishedAtMs: NOW - 30_000,
  atMs: NOW - 30_000,
  postRaceAtMs: null,
  postRaceDurationS: null,
});

describe("laneReturnRoom", () => {
  it("names the room the group on track will walk back into", () => {
    expect(laneReturnRoom(lane({ racing: racing("red") }))).toBe("red");
  });

  it("falls to the pit when nothing is out — they are still to hand kit over", () => {
    expect(laneReturnRoom(lane({ pitIn: pitIn("blue") }))).toBe("blue");
  });

  it("prefers the racing group over the one already in the pit", () => {
    expect(laneReturnRoom(lane({ racing: racing("red"), pitIn: pitIn("blue") }))).toBe("red");
  });

  it("ignores the seats and the karts — those groups are not coming back yet", () => {
    // They have LEFT their room. It is free for the next heat, which is the
    // whole reason the rooms leapfrog.
    expect(laneReturnRoom(lane({ holding: holding("red"), karts: karts("blue") }))).toBeNull();
  });

  it("is null for an empty lane, a null lane, and a group with no room", () => {
    expect(laneReturnRoom(EMPTY_PIT_LANE)).toBeNull();
    expect(laneReturnRoom(null)).toBeNull();
    expect(laneReturnRoom(lane({ racing: racing(null) }))).toBeNull();
  });
});

describe("lastRoomUsed", () => {
  it("reads the journey backwards — holding, karts, on track, pit", () => {
    expect(lastRoomUsed(lane({ holding: holding("blue"), racing: racing("red") }))).toBe("blue");
    expect(lastRoomUsed(lane({ karts: karts("blue"), pitIn: pitIn("red") }))).toBe("blue");
    expect(lastRoomUsed(lane({ racing: racing("red"), pitIn: pitIn("blue") }))).toBe("red");
    expect(lastRoomUsed(lane({ pitIn: pitIn("blue") }))).toBe("blue");
  });

  it("sees the group out on track — the gap that made the suggestion backwards", () => {
    // Nothing in the seats, nothing in the karts, nobody in the pit: for the
    // fourteen minutes 28 is out, this was reading as "nobody has taken a room".
    expect(lastRoomUsed(lane({ racing: racing("red") }))).toBe("red");
  });

  it("is null when no group tonight carries a room", () => {
    expect(lastRoomUsed(EMPTY_PIT_LANE)).toBeNull();
    expect(lastRoomUsed(null)).toBeNull();
  });
});

describe("suggestMegaRoom", () => {
  it("suggests the room the race on track is NOT coming back to", () => {
    const l = lane({ racing: racing("red") });
    expect(suggestMegaRoom({ free: ["red", "blue"], lane: l })).toBe("blue");
    // The two answers are the same fact from two sides.
    expect(laneReturnRoom(l)).toBe("red");
  });

  it("leapfrogs off the last group briefed when both rooms are free", () => {
    expect(
      suggestMegaRoom({ free: ["red", "blue"], lane: lane({ holding: holding("blue") }) }),
    ).toBe("red");
  });

  it("gives the only free room whatever else is true", () => {
    // Even the room the race is returning to: the alternative is interrupting a
    // film, which is a Replace and a human call.
    expect(suggestMegaRoom({ free: ["red"], lane: lane({ racing: racing("red") }) })).toBe("red");
  });

  it("suggests nothing when both rooms are busy", () => {
    expect(suggestMegaRoom({ free: [], lane: lane({ racing: racing("red") }) })).toBeNull();
  });

  it("falls to red when nothing tonight names a room", () => {
    expect(suggestMegaRoom({ free: ["red", "blue"], lane: EMPTY_PIT_LANE })).toBe("red");
    expect(suggestMegaRoom({ free: ["red", "blue"], lane: null })).toBe("red");
  });
});
