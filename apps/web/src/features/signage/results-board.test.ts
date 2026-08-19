import { describe, it, expect } from "vitest";
import {
  buildResultsView,
  heatLabelFor,
  mergeCandidates,
  raceTypeFromHeatName,
  rankFinished,
  WIDE_GRID_FROM,
  type CapturedDriver,
} from "./results-board";

/** A grid, terse. Position is index+1 unless given. */
function grid(rows: Array<Partial<CapturedDriver> & { name: string }>): CapturedDriver[] {
  return rows.map((r, i) => ({
    name: r.name,
    bestMs: r.bestMs === undefined ? 40_000 : r.bestMs,
    kart: r.kart ?? String(i + 1),
    laps: r.laps ?? 12,
    position: r.position ?? i + 1,
  }));
}

describe("raceTypeFromHeatName", () => {
  it("reads the type off the venue broadcast's name", () => {
    expect(raceTypeFromHeatName("66 - Mega Pro")).toBe("Mega Pro");
  });

  it("reads the type off the captured frame's humanised name", () => {
    expect(raceTypeFromHeatName("Heat 66 - Mega Pro")).toBe("Mega Pro");
  });

  it("keeps a multi-word type intact", () => {
    expect(raceTypeFromHeatName("12 - Blue Junior Starter")).toBe("Blue Junior Starter");
  });

  it("returns null for a group event with no separator", () => {
    expect(raceTypeFromHeatName("Henderson Birthday Party")).toBeNull();
  });

  it("returns null for a name that separates but says nothing after it", () => {
    expect(raceTypeFromHeatName("44 - ")).toBeNull();
  });

  it("returns null for absent names rather than throwing", () => {
    expect(raceTypeFromHeatName(null)).toBeNull();
    expect(raceTypeFromHeatName(undefined)).toBeNull();
    expect(raceTypeFromHeatName("")).toBeNull();
  });
});

describe("heatLabelFor", () => {
  it("names the heat and its type", () => {
    expect(heatLabelFor("blue", 59, "Blue Intermediate")).toBe("Heat 59 · Blue Intermediate");
  });

  it("falls back to the track when the type is unknown — never a bare number", () => {
    expect(heatLabelFor("red", 44, null)).toBe("Heat 44 · Red Track");
  });

  it("never prints an empty heat", () => {
    expect(heatLabelFor("mega", null, null)).toBe("Mega Track");
    expect(heatLabelFor("mega", null, "Mega Pro")).toBe("Mega Pro");
  });
});

describe("buildResultsView — qualification", () => {
  it("marks everyone at or under the Blue Intermediate → Pro cutoff (32.500)", () => {
    const view = buildResultsView({
      track: "blue",
      sessionId: "58569688",
      heatNumber: 59,
      heatName: "Heat 59 - Blue Intermediate",
      endedAtMs: 1_700_000_000_000,
      drivers: grid([
        { name: "Kenny Rosencrans", bestMs: 32_114 },
        { name: "Dana Whitfield", bestMs: 32_500 }, // exactly on it — qualifies
        { name: "Marcus Webb", bestMs: 33_114 },
      ]),
    });

    expect(view.target).toEqual({ level: "Pro", ms: 32_500 });
    expect(view.qualified.map((d) => d.name)).toEqual(["Kenny Rosencrans", "Dana Whitfield"]);
    expect(view.drivers[2].qualified).toBe(false);
  });

  it("a racer who never set a lap cannot qualify", () => {
    const view = buildResultsView({
      track: "blue",
      sessionId: "1",
      heatNumber: 59,
      heatName: "59 - Blue Intermediate",
      endedAtMs: 1,
      drivers: grid([{ name: "Grace Lindqvist", bestMs: null }]),
    });
    expect(view.qualified).toHaveLength(0);
    expect(view.closest).toBeNull();
  });

  it("climbs the JUNIOR ladder, not the adult one, for a junior grid", () => {
    // 50s would clear no adult Blue cutoff, but Junior Starter aims at 1:15.
    const view = buildResultsView({
      track: "blue",
      sessionId: "1",
      heatNumber: 12,
      heatName: "12 - Blue Junior Starter",
      endedAtMs: 1,
      drivers: grid([{ name: "Nate Okonkwo", bestMs: 50_000 }]),
    });
    expect(view.target).toEqual({ level: "Junior Intermediate", ms: 75_000 });
    expect(view.qualified.map((d) => d.name)).toEqual(["Nate Okonkwo"]);
  });

  it("a Pro grid has no target, so nobody is marked and there is no closest miss", () => {
    const view = buildResultsView({
      track: "blue",
      sessionId: "1",
      heatNumber: 61,
      heatName: "61 - Blue Pro",
      endedAtMs: 1,
      drivers: grid([{ name: "Ilya Kravchenko", bestMs: 31_208 }]),
    });
    expect(view.target).toBeNull();
    expect(view.qualified).toHaveLength(0);
    expect(view.closest).toBeNull();
  });

  it("an unparseable heat name means no target — never a guessed one", () => {
    const view = buildResultsView({
      track: "blue",
      sessionId: "1",
      heatNumber: null,
      heatName: "Henderson Birthday Party",
      endedAtMs: 1,
      drivers: grid([{ name: "Somebody", bestMs: 20_000 }]),
    });
    expect(view.raceType).toBeNull();
    expect(view.target).toBeNull();
    expect(view.qualified).toHaveLength(0);
  });

  it("uses MEGA cutoffs on the combined circuit, not Red's", () => {
    // 1:07.844 clears Mega Pro (1:08.5). Judged against Red's 37s it would fail.
    const view = buildResultsView({
      track: "mega",
      sessionId: "1",
      heatNumber: 66,
      heatName: "66 - Mega Intermediate",
      endedAtMs: 1,
      drivers: grid([{ name: "Dustin Landers", bestMs: 67_844 }]),
    });
    expect(view.target).toEqual({ level: "Pro", ms: 68_500 });
    expect(view.qualified.map((d) => d.name)).toEqual(["Dustin Landers"]);
  });
});

describe("buildResultsView — closest miss", () => {
  it("names the smallest positive gap to the target", () => {
    const view = buildResultsView({
      track: "red",
      sessionId: "1",
      heatNumber: 44,
      heatName: "44 - Red Starter",
      endedAtMs: 1,
      drivers: grid([
        { name: "Devon Marchetti", bestMs: 46_902 },
        { name: "Hailey Nguyen", bestMs: 47_334 },
      ]),
    });
    expect(view.target).toEqual({ level: "Intermediate", ms: 46_000 });
    expect(view.qualified).toHaveLength(0);
    expect(view.closest).toEqual({ name: "Devon Marchetti", bestMs: 46_902, gapMs: 902 });
  });

  it("ignores racers with no lap when picking the closest", () => {
    const view = buildResultsView({
      track: "red",
      sessionId: "1",
      heatNumber: 44,
      heatName: "44 - Red Starter",
      endedAtMs: 1,
      drivers: grid([
        { name: "No Lap", bestMs: null },
        { name: "Sofia Brennan", bestMs: 48_000 },
      ]),
    });
    expect(view.closest?.name).toBe("Sofia Brennan");
  });

  it("is null when everybody qualified — there is nobody to be close", () => {
    const view = buildResultsView({
      track: "red",
      sessionId: "1",
      heatNumber: 44,
      heatName: "44 - Red Starter",
      endedAtMs: 1,
      drivers: grid([{ name: "Fast One", bestMs: 40_000 }]),
    });
    expect(view.qualified).toHaveLength(1);
    expect(view.closest).toBeNull();
  });
});

describe("buildResultsView — fastest lap and podium", () => {
  it("fastest lap is the best of the race, NOT necessarily the winner", () => {
    const view = buildResultsView({
      track: "blue",
      sessionId: "1",
      heatNumber: 61,
      heatName: "61 - Blue Pro",
      endedAtMs: 1,
      drivers: grid([
        { name: "Ilya Kravchenko", bestMs: 31_208, position: 1 },
        { name: "Renata Villalobos", bestMs: 31_044, position: 2 },
      ]),
    });
    expect(view.fastest).toEqual({ name: "Renata Villalobos", bestMs: 31_044 });
  });

  it("is null when nobody set a lap at all", () => {
    const view = buildResultsView({
      track: "blue",
      sessionId: "1",
      heatNumber: 1,
      heatName: "1 - Blue Starter",
      endedAtMs: 1,
      drivers: grid([
        { name: "A", bestMs: null },
        { name: "B", bestMs: null },
      ]),
    });
    expect(view.fastest).toBeNull();
  });

  it("podium is the top three finishers", () => {
    const view = buildResultsView({
      track: "blue",
      sessionId: "1",
      heatNumber: 61,
      heatName: "61 - Blue Pro",
      endedAtMs: 1,
      drivers: grid([{ name: "A" }, { name: "B" }, { name: "C" }, { name: "D" }]),
    });
    expect(view.podium.map((d) => d.name)).toEqual(["A", "B", "C"]);
  });

  it("excludes unplaced racers (position 0) from the podium", () => {
    const view = buildResultsView({
      track: "blue",
      sessionId: "1",
      heatNumber: 61,
      heatName: "61 - Blue Pro",
      endedAtMs: 1,
      drivers: grid([
        { name: "Never Started", position: 0 },
        { name: "A", position: 1 },
        { name: "B", position: 2 },
        { name: "C", position: 3 },
      ]),
    });
    expect(view.podium.map((d) => d.name)).toEqual(["A", "B", "C"]);
  });
});

describe("buildResultsView — ordering and layout", () => {
  it("sorts by finishing position whatever order the capture arrived in", () => {
    const view = buildResultsView({
      track: "blue",
      sessionId: "1",
      heatNumber: 1,
      heatName: "1 - Blue Starter",
      endedAtMs: 1,
      drivers: grid([
        { name: "Third", position: 3 },
        { name: "First", position: 1 },
        { name: "Second", position: 2 },
      ]),
    });
    expect(view.drivers.map((d) => d.name)).toEqual(["First", "Second", "Third"]);
  });

  it("stays single-column just below the split", () => {
    const view = buildResultsView({
      track: "blue",
      sessionId: "1",
      heatNumber: 1,
      heatName: "1 - Blue Starter",
      endedAtMs: 1,
      drivers: grid(Array.from({ length: WIDE_GRID_FROM - 1 }, (_, i) => ({ name: `Racer ${i}` }))),
    });
    expect(view.wide).toBe(false);
  });

  it("splits into two columns at the threshold", () => {
    const view = buildResultsView({
      track: "mega",
      sessionId: "1",
      heatNumber: 66,
      heatName: "66 - Mega Intermediate",
      endedAtMs: 1,
      drivers: grid(Array.from({ length: WIDE_GRID_FROM }, (_, i) => ({ name: `Racer ${i}` }))),
    });
    expect(view.wide).toBe(true);
  });
});

describe("mergeCandidates", () => {
  it("fills gaps from later sources without overwriting earlier ones", () => {
    const merged = mergeCandidates([
      [{ sessionId: "A", heatNumber: 59, heatName: null, endedAtMs: 100, track: "blue" }],
      [
        {
          sessionId: "A",
          heatNumber: 999,
          heatName: "59 - Blue Intermediate",
          endedAtMs: 200,
          track: "blue",
        },
      ],
    ]);
    expect(merged).toEqual([
      {
        sessionId: "A",
        heatNumber: 59,
        heatName: "59 - Blue Intermediate",
        endedAtMs: 100,
        track: "blue",
      },
    ]);
  });

  it("adds races a earlier source never saw", () => {
    const merged = mergeCandidates([
      [{ sessionId: "A", heatNumber: 1, heatName: null, endedAtMs: 1, track: "blue" }],
      [{ sessionId: "B", heatNumber: 2, heatName: null, endedAtMs: 2, track: "blue" }],
    ]);
    expect(merged.map((c) => c.sessionId).sort()).toEqual(["A", "B"]);
  });

  it("lets a later source supply an end the first one lacked", () => {
    const merged = mergeCandidates([
      [{ sessionId: "A", heatNumber: 1, heatName: null, endedAtMs: null, track: "blue" }],
      [{ sessionId: "A", heatNumber: 1, heatName: null, endedAtMs: 500, track: "blue" }],
    ]);
    expect(merged[0].endedAtMs).toBe(500);
  });

  it("drops rows with no session id rather than keying on empty string", () => {
    const merged = mergeCandidates([
      [{ sessionId: "", heatNumber: 1, heatName: null, endedAtMs: 1, track: "blue" }],
    ]);
    expect(merged).toHaveLength(0);
  });
});

describe("rankFinished", () => {
  it("orders by when the race ENDED, newest first — never by heat number", () => {
    // Heat 76 is a staff-inserted session: the day-max number, run early.
    const ranked = rankFinished([
      { sessionId: "A", heatNumber: 51, heatName: null, endedAtMs: 300, track: "blue" },
      { sessionId: "B", heatNumber: 76, heatName: null, endedAtMs: 100, track: "blue" },
      { sessionId: "C", heatNumber: 52, heatName: null, endedAtMs: 200, track: "blue" },
    ]);
    expect(ranked.map((c) => c.sessionId)).toEqual(["A", "C", "B"]);
  });

  it("drops races that have not finished", () => {
    const ranked = rankFinished([
      { sessionId: "running", heatNumber: 60, heatName: null, endedAtMs: null, track: "blue" },
      { sessionId: "done", heatNumber: 59, heatName: null, endedAtMs: 5, track: "blue" },
    ]);
    expect(ranked.map((c) => c.sessionId)).toEqual(["done"]);
  });

  it("is empty before the first race of the day finishes", () => {
    expect(rankFinished([])).toEqual([]);
  });
});
