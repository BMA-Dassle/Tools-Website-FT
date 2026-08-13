import { describe, expect, it } from "vitest";
import {
  MAX_PLAUSIBLE_SPAN_MS,
  formatWaitMs,
  sessionWaits,
  summariseWaits,
  summariseWaitsByTrack,
  waitsForDay,
  type BriefingSpanSource,
  type RaceWindow,
} from "./wait-times";

const T0 = 1_786_487_400_000; // an ordinary evening
const MIN = 60_000;

/** A complete, ordinary group: checked in, called, briefed, raced. */
function group(over: Partial<BriefingSpanSource> = {}): BriefingSpanSource {
  return {
    sessionId: "58509552",
    track: "red",
    heatNumber: 24,
    raceType: "Starter",
    checkinFirstAtMs: T0,
    checkinLastAtMs: T0 + 2 * MIN,
    calledAtMs: T0 + 3 * MIN,
    sentAtMs: T0 + 6 * MIN,
    startedAtMs: T0 + 7 * MIN,
    endedAtMs: T0 + 12 * MIN,
    checkinIn: 8,
    checkinTotal: 10,
    ...over,
  };
}

function race(over: Partial<RaceWindow> = {}): RaceWindow {
  return {
    sessionId: "58509552",
    startedAtMs: T0 + 15 * MIN,
    endedAtMs: T0 + 25 * MIN,
    ...over,
  };
}

describe("sessionWaits", () => {
  it("measures every movement of an ordinary group", () => {
    const w = sessionWaits(group(), race());
    expect(w.checkinToRoomMs).toBe(6 * MIN); // first racer in → sent to the room
    expect(w.checkinSpreadMs).toBe(2 * MIN); // how spread out their arrivals were
    expect(w.calledToRoomMs).toBe(3 * MIN); // called → sent
    expect(w.roomToFilmMs).toBe(1 * MIN); // the walk over
    expect(w.roomToRaceMs).toBe(9 * MIN); // sent → flag: what the desk can act on
    expect(w.inRoomMs).toBe(6 * MIN); // sent → left the room
    expect(w.briefingToRaceMs).toBe(3 * MIN); // HOLDING
    expect(w.calledToRaceMs).toBe(12 * MIN); // called → flag
    expect(w.calledToRaceEndMs).toBe(22 * MIN); // the whole experience
    expect(w.raceMs).toBe(10 * MIN);
    expect(w.implausible).toEqual([]);
  });

  it("reports a group check-in as a real zero spread, not a gap", () => {
    // Staff check a party in as ONE action: every racer gets the same stamp.
    const w = sessionWaits(group({ checkinLastAtMs: T0 }), race());
    expect(w.checkinSpreadMs).toBe(0);
    expect(w.checkinToRoomMs).toBe(6 * MIN);
  });

  it("drops a span rather than zeroing it when an end is missing", () => {
    // A heat sent before the anchors were ever captured.
    const w = sessionWaits(
      group({ calledAtMs: null, checkinFirstAtMs: null, checkinLastAtMs: null }),
      race(),
    );
    expect(w.calledToRoomMs).toBeNull();
    expect(w.calledToRaceMs).toBeNull();
    expect(w.checkinToRoomMs).toBeNull();
    // The movements that DO have both ends still measure.
    expect(w.roomToFilmMs).toBe(1 * MIN);
    expect(w.briefingToRaceMs).toBe(3 * MIN);
    expect(w.implausible).toEqual([]);
  });

  it("has nothing to say about a group still in the room", () => {
    const w = sessionWaits(group({ endedAtMs: null }), null);
    expect(w.inRoomMs).toBeNull();
    expect(w.briefingToRaceMs).toBeNull();
    expect(w.calledToRaceMs).toBeNull();
    expect(w.raceMs).toBeNull();
    // Everything before the room still counts.
    expect(w.calledToRoomMs).toBe(3 * MIN);
  });

  it("discards an impossible span and says which one", () => {
    // A room nobody cleared, closed hours later.
    const w = sessionWaits(group({ endedAtMs: T0 + 5 * 3_600_000 }), race());
    expect(w.inRoomMs).toBeNull();
    expect(w.implausible).toContain("inRoomMs");
    // The race started BEFORE that bogus end, so holding is negative — also out.
    expect(w.briefingToRaceMs).toBeNull();
    expect(w.implausible).toContain("briefingToRaceMs");
  });

  it("refuses out-of-order stamps instead of reporting a negative wait", () => {
    const w = sessionWaits(group({ calledAtMs: T0 + 30 * MIN }), race());
    expect(w.calledToRoomMs).toBeNull();
    expect(w.implausible).toContain("calledToRoomMs");
  });

  it("keeps a span exactly at the plausibility bound", () => {
    const w = sessionWaits(
      group({ checkinFirstAtMs: T0, sentAtMs: T0 + MAX_PLAUSIBLE_SPAN_MS }),
      null,
    );
    expect(w.checkinToRoomMs).toBe(MAX_PLAUSIBLE_SPAN_MS);
  });
});

describe("waitsForDay", () => {
  it("joins each briefing to its own race by session id", () => {
    const rows = waitsForDay(
      [group(), group({ sessionId: "999", heatNumber: 25 })],
      [race(), race({ sessionId: "999", startedAtMs: T0 + 40 * MIN, endedAtMs: T0 + 50 * MIN })],
    );
    expect(rows).toHaveLength(2);
    expect(rows[0].raceMs).toBe(10 * MIN);
    expect(rows[1].raceMs).toBe(10 * MIN);
  });

  it("counts a Mega group briefed in BOTH rooms as two waits, one race", () => {
    // Same session, two rooms — both rooms really did wait.
    const rows = waitsForDay([group(), group()], [race()]);
    expect(rows).toHaveLength(2);
    expect(rows[0].briefingToRaceMs).toBe(3 * MIN);
    expect(rows[1].briefingToRaceMs).toBe(3 * MIN);
  });

  it("leaves a briefing with no race half-measured", () => {
    const [row] = waitsForDay([group()], []);
    expect(row.inRoomMs).toBe(6 * MIN);
    expect(row.calledToRaceMs).toBeNull();
  });
});

describe("summariseWaits", () => {
  it("averages what it has and reports the n behind each number", () => {
    const rows = waitsForDay(
      [group(), group({ sessionId: "2", sentAtMs: T0 + 8 * MIN, startedAtMs: T0 + 10 * MIN })],
      [race(), race({ sessionId: "2" })],
    );
    const s = summariseWaits(rows);
    expect(s.roomToFilmMs.n).toBe(2);
    expect(s.roomToFilmMs.avgMs).toBe(1.5 * MIN); // 1 min and 2 min
    expect(s.roomToFilmMs.minMs).toBe(1 * MIN);
    expect(s.roomToFilmMs.maxMs).toBe(2 * MIN);
  });

  it("reports the median as well as the mean, so one stuck group cannot lie", () => {
    const rows = waitsForDay(
      [
        group({ sessionId: "a", startedAtMs: T0 + 7 * MIN }), // 1 min
        group({ sessionId: "b", startedAtMs: T0 + 7 * MIN }), // 1 min
        group({ sessionId: "c", startedAtMs: T0 + 66 * MIN }), // 60 min — forgotten
      ],
      [],
    );
    const s = summariseWaits(rows);
    expect(s.roomToFilmMs.medianMs).toBe(1 * MIN);
    expect(s.roomToFilmMs.avgMs).toBe(Math.round((62 * MIN) / 3));
  });

  it("averages an even count without inventing precision", () => {
    const rows = waitsForDay(
      [
        group({ sessionId: "a", startedAtMs: T0 + 7 * MIN }), // 1
        group({ sessionId: "b", startedAtMs: T0 + 9 * MIN }), // 3
      ],
      [],
    );
    expect(summariseWaits(rows).roomToFilmMs.medianMs).toBe(2 * MIN);
  });

  it("says nothing rather than 0:00 when it has no data", () => {
    const s = summariseWaits([]);
    expect(s.calledToRaceMs).toEqual({
      n: 0,
      avgMs: null,
      medianMs: null,
      minMs: null,
      maxMs: null,
      discarded: 0,
    });
  });

  it("counts discards separately from never-measured", () => {
    const rows = waitsForDay(
      [
        group({ sessionId: "ok" }),
        group({ sessionId: "broken", endedAtMs: T0 + 5 * 3_600_000 }),
        group({ sessionId: "unmeasured", endedAtMs: null }),
      ],
      [race({ sessionId: "ok" })],
    );
    const s = summariseWaits(rows);
    expect(s.inRoomMs.n).toBe(1); // only the good one
    expect(s.inRoomMs.discarded).toBe(1); // the impossible one is COUNTED
    // The open room contributes to neither — it was simply never measured.
    expect(s.inRoomMs.n + s.inRoomMs.discarded).toBe(2);
  });
});

describe("summariseWaitsByTrack", () => {
  it("keeps blue and red apart — one merged average describes neither", () => {
    const rows = waitsForDay(
      [
        // Red: sent 6, raced at 15 → 9 min from send to flag.
        group({ sessionId: "r1", track: "red" }),
        // Blue running 10 minutes behind on the same night.
        group({ sessionId: "b1", track: "blue" }),
      ],
      [
        race({ sessionId: "r1" }),
        race({ sessionId: "b1", startedAtMs: T0 + 25 * MIN, endedAtMs: T0 + 35 * MIN }),
      ],
    );
    const byTrack = summariseWaitsByTrack(rows);
    expect(byTrack.red.roomToRaceMs.medianMs).toBe(9 * MIN);
    expect(byTrack.blue.roomToRaceMs.medianMs).toBe(19 * MIN);
    // …and the combined number is a night neither track had.
    expect(summariseWaits(rows).roomToRaceMs.medianMs).toBe(14 * MIN);
  });

  it("gives a Mega day its own bucket rather than merging the two rooms", () => {
    const rows = waitsForDay(
      [group({ sessionId: "m1", track: "mega" }), group({ sessionId: "m2", track: "mega" })],
      [race({ sessionId: "m1" }), race({ sessionId: "m2" })],
    );
    const byTrack = summariseWaitsByTrack(rows);
    expect(Object.keys(byTrack)).toEqual(["mega"]);
    expect(byTrack.mega.roomToRaceMs.n).toBe(2);
  });

  it("does not invent a bucket for a track that ran nothing", () => {
    const byTrack = summariseWaitsByTrack(waitsForDay([group({ track: "red" })], []));
    expect(byTrack.blue).toBeUndefined();
  });

  it("files a trackless row under unknown rather than dropping it", () => {
    const byTrack = summariseWaitsByTrack(waitsForDay([group({ track: null })], []));
    expect(byTrack.unknown.roomToFilmMs.n).toBe(1);
  });
});

describe("formatWaitMs", () => {
  it("reads as a clock, and says nothing when it knows nothing", () => {
    expect(formatWaitMs(0)).toBe("0:00");
    expect(formatWaitMs(90_000)).toBe("1:30");
    expect(formatWaitMs(22 * MIN)).toBe("22:00");
    expect(formatWaitMs(3_930_000)).toBe("1:05:30");
    expect(formatWaitMs(null)).toBe("—");
    expect(formatWaitMs(NaN)).toBe("—");
  });
});
