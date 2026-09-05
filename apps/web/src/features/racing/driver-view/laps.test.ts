import { describe, expect, it } from "vitest";
import { formatDelta, formatLapTime, isPersonalBest, numberLaps, summarise } from "./laps";

/**
 * KART 15, BLUE HEAT 65, 2026-09-05 — the owner's own run, verbatim from
 * `kart:events:queue`. Two rollout crossings with no time at all, then seven
 * timed laps with the best on lap 7. This is the ugly case on purpose: a
 * fixture of nine clean laps would hide the thing that actually bites.
 */
const CROSSINGS = [
  { passingId: "p1", lapTimeMs: null, atUtc: "2026-09-05T03:28:10.000Z" },
  { passingId: "p2", lapTimeMs: null, atUtc: "2026-09-05T03:28:41.000Z" },
  { passingId: "p3", lapTimeMs: 53419, atUtc: "2026-09-05T03:29:35.000Z" },
  { passingId: "p4", lapTimeMs: 33881, atUtc: "2026-09-05T03:30:09.000Z" },
  { passingId: "p5", lapTimeMs: 33761, atUtc: "2026-09-05T03:30:42.000Z" },
  { passingId: "p6", lapTimeMs: 34608, atUtc: "2026-09-05T03:31:17.000Z" },
  { passingId: "p7", lapTimeMs: 31208, atUtc: "2026-09-05T03:31:48.000Z" },
  { passingId: "p8", lapTimeMs: 44469, atUtc: "2026-09-05T03:32:33.000Z" },
  { passingId: "p9", lapTimeMs: 40768, atUtc: "2026-09-05T03:33:13.000Z" },
];

describe("numberLaps", () => {
  it("numbers by crossing time, rollout laps included", () => {
    const laps = numberLaps(CROSSINGS);
    expect(laps).toHaveLength(9);
    expect(laps[0].lapNumber).toBe(1);
    expect(laps[0].lapTimeMs).toBeNull();
    expect(laps[6].lapNumber).toBe(7);
    expect(laps[6].lapTimeMs).toBe(31208);
  });

  it("orders by the venue's stamp, not by arrival", () => {
    // A bridge reconnect replays a whole day out of order. Lap 3 landing after
    // lap 9 must not renumber the heat.
    const shuffled = [
      CROSSINGS[8],
      CROSSINGS[2],
      CROSSINGS[0],
      ...CROSSINGS.slice(3, 8),
      CROSSINGS[1],
    ];
    const laps = numberLaps(shuffled);
    expect(laps.map((l) => l.passingId)).toEqual(CROSSINGS.map((c) => c.passingId));
  });
});

describe("summarise", () => {
  const s = summarise(numberLaps(CROSSINGS));

  it("counts every crossing, including the rollout ones", () => {
    expect(s.count).toBe(9);
  });

  it("never lets a rollout lap become a 0.000 best", () => {
    expect(s.timed).toHaveLength(7);
    expect(s.best?.lapTimeMs).toBe(31208);
    expect(s.best?.lapNumber).toBe(7);
  });

  it("finds the slowest timed lap for the chart label", () => {
    expect(s.worst?.lapTimeMs).toBe(53419);
  });

  it("reports the last TIMED lap, not the last crossing", () => {
    expect(s.last?.lapNumber).toBe(9);
    expect(s.last?.lapTimeMs).toBe(40768);
  });

  it("averages only the timed laps", () => {
    const mean = Math.round((53419 + 33881 + 33761 + 34608 + 31208 + 44469 + 40768) / 7);
    expect(s.averageMs).toBe(mean);
  });

  it("says nothing rather than guessing on an empty heat", () => {
    const empty = summarise([]);
    expect(empty.best).toBeNull();
    expect(empty.averageMs).toBeNull();
    expect(empty.count).toBe(0);
  });
});

describe("isPersonalBest", () => {
  const upToLap6 = numberLaps(CROSSINGS.slice(0, 6));

  it("is true when the new lap beats everything before it", () => {
    expect(isPersonalBest(upToLap6, 31208)).toBe(true);
  });

  it("is false for a slower lap", () => {
    expect(isPersonalBest(upToLap6, 40768)).toBe(false);
  });

  it("is false for an exact tie — nothing was beaten", () => {
    expect(isPersonalBest(upToLap6, 33761)).toBe(false);
  });

  it("does not celebrate the first timed lap of a heat", () => {
    // Two rollout laps and nothing else: there is no prior best to beat, and
    // telling someone their only lap is their fastest is noise.
    expect(isPersonalBest(numberLaps(CROSSINGS.slice(0, 2)), 53419)).toBe(false);
  });

  it("ignores a rollout crossing", () => {
    expect(isPersonalBest(upToLap6, null)).toBe(false);
  });
});

describe("formatting", () => {
  it("drops the minute when there is not one", () => {
    expect(formatLapTime(31208)).toBe("31.208");
  });

  it("keeps it when there is", () => {
    expect(formatLapTime(66832)).toBe("1:06.832");
  });

  it("shows a dash rather than a zero for a lap with no time", () => {
    expect(formatLapTime(null)).toBe("—");
    expect(formatLapTime(0)).toBe("—");
  });

  it("signs the delta against the best", () => {
    expect(formatDelta(34608, 31208)).toBe("+3.400");
    expect(formatDelta(31208, 31208)).toBe("");
    expect(formatDelta(null, 31208)).toBe("");
  });
});
