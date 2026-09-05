import { describe, expect, it } from "vitest";
import { formatLapMs, shapeRaceHistory, summarizeRaceHistory, trackKeyOf } from "./race-history";

/** Three rows of the owner's live sample (personId 14072115, 2026-09-04). */
const sample = [
  {
    participantId: "56227366",
    scheduledStart: "2026-07-24T20:00:00",
    resourceName: "Red Track",
    sessionName: "46 - Red Starter",
    kart: "6",
    finishPosition: 2,
    bestScore: 44233,
    avgScore: 44606,
    scoreLaps: 9,
  },
  {
    participantId: "46759078",
    scheduledStart: "2026-05-07T21:00:00",
    resourceName: "Blue Track",
    sessionName: "41 - Blue Intermediate",
    kart: "32",
    finishPosition: 1,
    bestScore: 32432,
    avgScore: 40883,
    scoreLaps: 11,
  },
  {
    participantId: "18094256",
    scheduledStart: "2025-10-14T18:00:00",
    resourceName: "Mega Track",
    sessionName: "12 - Mega Starter",
    kart: "8",
    finishPosition: 3,
    bestScore: 85678,
    avgScore: 91406,
    scoreLaps: 3,
  },
];

describe("race history shaping", () => {
  it("shapes rows newest first with ms scores kept as numbers", () => {
    const rows = shapeRaceHistory([...sample].reverse());
    expect(rows.map((r) => r.heat)).toEqual([
      "46 - Red Starter",
      "41 - Blue Intermediate",
      "12 - Mega Starter",
    ]);
    expect(rows[0]).toMatchObject({
      track: "Red Track",
      kart: "6",
      bestMs: 44233,
      position: 2,
      laps: 9,
    });
  });

  it("drops rows without a start and nulls non-positive scores", () => {
    const rows = shapeRaceHistory([
      { resourceName: "Blue Track" },
      { scheduledStart: "2026-01-01T10:00:00", bestScore: 0, finishPosition: null },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].bestMs).toBeNull();
    expect(rows[0].position).toBeNull();
  });

  it("summarises best per track, earned level and the closest climb", () => {
    const s = summarizeRaceHistory(shapeRaceHistory(sample));
    expect(s.races).toBe(3);
    expect(s.best).toEqual({ red: 44233, blue: 32432, mega: 85678 });
    // 32.432 on Blue is under the 32.5 Pro line; 44.233 Red is Intermediate pace; Mega 85.678 is Intermediate pace.
    expect(s.earned).toEqual({ blue: "Pro", red: "Intermediate", mega: "Intermediate" });
    // Blue is already Pro (no climb). Red → Pro needs 37.000 (gap 7.233 s);
    // Mega → Pro needs 68.500 (gap 17.178 s). Closest is Red.
    expect(s.next).toEqual({ track: "red", level: "Pro", targetMs: 37_000, gapMs: 7233 });
    expect(s.first).toBe("2025-10-14T18:00:00");
    expect(s.last).toBe("2026-07-24T20:00:00");
  });

  it("no climb when every track is at Pro pace or nothing is timed", () => {
    const pro = summarizeRaceHistory(
      shapeRaceHistory([
        { scheduledStart: "2026-01-01T10:00:00", resourceName: "Blue Track", bestScore: 31000 },
      ]),
    );
    expect(pro.next).toBeNull();
    expect(summarizeRaceHistory([]).next).toBeNull();
  });

  it("formats laps like the leaderboard and matches tracks loosely", () => {
    expect(formatLapMs(44233)).toBe("44.233");
    expect(formatLapMs(84208)).toBe("1:24.208");
    expect(formatLapMs(null)).toBe("—");
    expect(trackKeyOf("Mega Track")).toBe("mega");
    expect(trackKeyOf("blue starter")).toBe("blue");
    expect(trackKeyOf("Arena")).toBeNull();
  });
});
