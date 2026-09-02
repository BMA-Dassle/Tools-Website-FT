import { describe, it, expect } from "vitest";
import {
  driversFromBestLaps,
  driversFromScores,
  heatNameFromScores,
  lapMsFromScore,
  type BestLapRow,
  type PandoraScoreRow,
} from "./results-fallback";

/**
 * THE CONTROL THAT LICENSED THIS MODULE. Heat 44 of 2026-09-01 was the last
 * race the cloud socket captured before it went dark at 19:36 ET; its stored
 * capture is ground truth. Reconstructing the same heat from the broadcast's
 * passings produced this exact table — driver for driver, millisecond for
 * millisecond. These are the real numbers, not invented ones.
 */
const HEAT_44_BEST_LAPS: BestLapRow[] = [
  { participantName: "David King", kart: "12", bestLapMs: 63772 },
  { participantName: "Joshua Ellis", kart: "3", bestLapMs: 62040 },
  { participantName: "Jay2quick", kart: "8", bestLapMs: 63278 },
  { participantName: "corbin polhill", kart: "17", bestLapMs: 62101 },
];

describe("driversFromBestLaps", () => {
  it("ranks heat 44 exactly as the real cloud capture did", () => {
    const drivers = driversFromBestLaps(HEAT_44_BEST_LAPS);
    expect(drivers.map((d) => [d.position, d.name, d.bestMs])).toEqual([
      [1, "Joshua Ellis", 62040],
      [2, "corbin polhill", 62101],
      [3, "Jay2quick", 63278],
      [4, "David King", 63772],
    ]);
  });

  it("carries karts through and admits it does not know lap counts", () => {
    const drivers = driversFromBestLaps(HEAT_44_BEST_LAPS);
    expect(drivers[0].kart).toBe("3");
    expect(drivers.every((d) => d.laps === 0)).toBe(true);
  });

  it("drops rows that could not name a racer or never set a lap", () => {
    const drivers = driversFromBestLaps([
      ...HEAT_44_BEST_LAPS,
      { participantName: "  ", kart: "9", bestLapMs: 60000 },
      { participantName: "Ghost", kart: null, bestLapMs: 0 },
    ]);
    expect(drivers).toHaveLength(4);
    expect(drivers[0].name).toBe("Joshua Ellis");
  });

  it("a null kart becomes an empty string, never the string 'null'", () => {
    const drivers = driversFromBestLaps([{ participantName: "A", kart: null, bestLapMs: 70000 }]);
    expect(drivers[0].kart).toBe("");
  });
});

/** Heat 63 of 2026-09-01 — the race the guests were standing in front of —
 *  as Pandora's scores endpoint returned it that night (subset). */
const HEAT_63_SCORES: PandoraScoreRow[] = [
  {
    position: 1,
    bestLap: 67031,
    laps: 8,
    alias: "connor annons",
    name: "Connor Annons",
    sessionName: "63 - Mega Intermediate",
  },
  { position: 2, bestLap: 67492, laps: 8, alias: "kai", name: "Kai R", sessionName: null },
  { position: 3, bestLap: 68110, laps: 7, alias: null, name: "Riley P", sessionName: null },
];

describe("driversFromScores", () => {
  const karts = new Map([
    ["connor annons", "21"],
    ["kai", "7"],
  ]);

  it("takes Pandora's positions verbatim — the official order is not re-derived", () => {
    const drivers = driversFromScores(HEAT_63_SCORES, karts);
    expect(drivers.map((d) => [d.position, d.name, d.bestMs, d.laps])).toEqual([
      [1, "connor annons", 67031, 8],
      [2, "kai", 67492, 8],
      [3, "Riley P", 68110, 7],
    ]);
  });

  it("prefers the alias (what the timing screens show) and falls back to name", () => {
    const drivers = driversFromScores(HEAT_63_SCORES, karts);
    expect(drivers[0].name).toBe("connor annons");
    expect(drivers[2].name).toBe("Riley P");
  });

  it("merges karts by name and leaves an honest blank when the broadcast never saw one", () => {
    const drivers = driversFromScores(HEAT_63_SCORES, karts);
    expect(drivers[0].kart).toBe("21");
    expect(drivers[2].kart).toBe("");
  });

  it("an unplaced row keeps position 0 and sorts to the end — never a fake podium", () => {
    const drivers = driversFromScores(
      [...HEAT_63_SCORES, { position: 0, bestLap: null, laps: 0, alias: "dnf", name: null }],
      karts,
    );
    expect(drivers[drivers.length - 1]).toMatchObject({ name: "dnf", position: 0, bestMs: null });
  });

  it("a nameless row is timing-system noise, not a racer", () => {
    const drivers = driversFromScores(
      [{ position: 1, bestLap: 65000, laps: 5, alias: "  ", name: null }],
      new Map(),
    );
    expect(drivers).toHaveLength(0);
  });
});

describe("lapMsFromScore", () => {
  it("passes milliseconds through (the unit observed live on 2026-09-01)", () => {
    expect(lapMsFromScore(67031)).toBe(67031);
  });

  it("converts a seconds-expressed lap — no karting lap is under a second", () => {
    expect(lapMsFromScore(67.031)).toBe(67031);
  });

  it("zero and null both mean 'never set a lap'", () => {
    expect(lapMsFromScore(0)).toBeNull();
    expect(lapMsFromScore(null)).toBeNull();
    expect(lapMsFromScore(undefined)).toBeNull();
  });
});

describe("heatNameFromScores", () => {
  it("finds the session name whichever row carries it", () => {
    expect(heatNameFromScores(HEAT_63_SCORES)).toBe("63 - Mega Intermediate");
    expect(heatNameFromScores([HEAT_63_SCORES[1]])).toBeNull();
  });
});
