import { describe, expect, it } from "vitest";
import { announceFloorFor, firstNameOf, qualifiersFromScores } from "./quals";
import {
  QUALIFY_INTERMEDIATE_BLUE,
  QUALIFY_INTERMEDIATE_RED,
  QUALIFY_PRO_BLUE,
} from "~/features/racing/qualify";

describe("announceFloorFor", () => {
  it("announces a level ABOVE the session's own tier", () => {
    expect(announceFloorFor("Starter")).toBe("Intermediate");
    expect(announceFloorFor("Junior Starter")).toBe("Intermediate");
    expect(announceFloorFor("Intermediate")).toBe("Pro");
    expect(announceFloorFor("Intermediate (2)")).toBe("Pro");
  });

  it("says nothing for a Pro heat — there is nowhere left to go", () => {
    expect(announceFloorFor("Pro")).toBeNull();
    expect(announceFloorFor("Junior Pro")).toBeNull();
  });

  it("says nothing for a session type it does not recognise", () => {
    expect(announceFloorFor(null)).toBeNull();
    expect(announceFloorFor("")).toBeNull();
    expect(announceFloorFor("Corporate Event")).toBeNull();
  });
});

describe("qualifiersFromScores", () => {
  const blue = { track: "Blue Track", raceType: "Starter" };

  it("names racers who beat the next level's cutoff", () => {
    const out = qualifiersFromScores(
      [
        { name: "Marcus Webb", bestLap: QUALIFY_PRO_BLUE - 500, persId: 1 },
        { name: "Ava Cole", bestLap: QUALIFY_INTERMEDIATE_BLUE - 500, persId: 2 },
      ],
      blue,
    );
    expect(out.map((q) => [q.firstName, q.level])).toEqual([
      ["Marcus", "Pro"],
      ["Ava", "Intermediate"],
    ]);
  });

  it("leaves out anyone who missed the cutoff", () => {
    const out = qualifiersFromScores(
      [{ name: "Slow Sam", bestLap: QUALIFY_INTERMEDIATE_BLUE + 1_000, persId: 3 }],
      blue,
    );
    expect(out).toEqual([]);
  });

  it("does NOT congratulate a Pro racer on Intermediate", () => {
    // The whole reason the floor exists: a 40s lap in a Pro heat clears the
    // Intermediate cutoff by miles and is not news.
    const out = qualifiersFromScores(
      [{ name: "Marcus Webb", bestLap: QUALIFY_INTERMEDIATE_BLUE - 1_000, persId: 1 }],
      { track: "Blue Track", raceType: "Pro" },
    );
    expect(out).toEqual([]);
  });

  it("in an Intermediate heat, only a Pro lap counts", () => {
    const scores = [
      { name: "Marcus Webb", bestLap: QUALIFY_PRO_BLUE - 100, persId: 1 },
      { name: "Ava Cole", bestLap: QUALIFY_INTERMEDIATE_BLUE - 100, persId: 2 },
    ];
    const out = qualifiersFromScores(scores, { track: "Blue Track", raceType: "Intermediate" });
    expect(out.map((q) => q.firstName)).toEqual(["Marcus"]);
  });

  it("uses the RED cutoffs on the red track", () => {
    // A lap that qualifies on Red would not on Blue — the tracks are different
    // lengths, so using the wrong cutoff would invent a level-up.
    const lap = QUALIFY_INTERMEDIATE_RED - 500;
    expect(
      qualifiersFromScores([{ name: "Ava", bestLap: lap, persId: 2 }], {
        track: "Red Track",
        raceType: "Starter",
      }),
    ).toHaveLength(1);
    expect(qualifiersFromScores([{ name: "Ava", bestLap: lap, persId: 2 }], blue)).toHaveLength(0);
  });

  it("never qualifies anyone off a Mega lap", () => {
    // Mega is the combined circuit — its laps cannot be compared to either
    // track's cutoff, so measuring against one would be measuring the wrong
    // distance.
    const out = qualifiersFromScores([{ name: "Marcus", bestLap: 30_000, persId: 1 }], {
      track: "Mega Track",
      raceType: "Starter",
    });
    expect(out).toEqual([]);
  });

  it("keeps a racer's fastest lap when the timing system lists them twice", () => {
    const out = qualifiersFromScores(
      [
        { name: "Marcus Webb", bestLap: QUALIFY_INTERMEDIATE_BLUE - 100, persId: 1 },
        { name: "Marcus Webb", bestLap: QUALIFY_PRO_BLUE - 100, persId: 1 },
      ],
      blue,
    );
    expect(out).toHaveLength(1);
    expect(out[0].level).toBe("Pro");
  });

  it("orders fastest first, so the board reads as a result", () => {
    const out = qualifiersFromScores(
      [
        { name: "Ava", bestLap: QUALIFY_INTERMEDIATE_BLUE - 100, persId: 2 },
        { name: "Marcus", bestLap: QUALIFY_PRO_BLUE - 100, persId: 1 },
        { name: "Sofia", bestLap: QUALIFY_INTERMEDIATE_BLUE - 900, persId: 3 },
      ],
      blue,
    );
    expect(out.map((q) => q.firstName)).toEqual(["Marcus", "Sofia", "Ava"]);
  });

  it("caps the list so a full Mega grid cannot overflow the board", () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      name: `Racer${i}`,
      bestLap: QUALIFY_INTERMEDIATE_BLUE - 100 - i,
      persId: i + 1,
    }));
    expect(qualifiersFromScores(many, { ...blue, limit: 12 })).toHaveLength(12);
  });

  it("survives empty, missing and malformed input", () => {
    expect(qualifiersFromScores(null, blue)).toEqual([]);
    expect(qualifiersFromScores([], blue)).toEqual([]);
    expect(qualifiersFromScores([{ name: null, bestLap: null }, { bestLap: 0 }, {}], blue)).toEqual(
      [],
    );
  });

  it("formats the lap as the proof", () => {
    const out = qualifiersFromScores([{ name: "Marcus", bestLap: 32_104, persId: 1 }], blue);
    expect(out[0].bestLap).toBe("32.104");
  });
});

describe("firstNameOf", () => {
  it("takes the first token", () => {
    expect(firstNameOf("Marcus Webb")).toBe("Marcus");
    expect(firstNameOf("Marcus")).toBe("Marcus");
  });

  it("handles surname-first imports", () => {
    expect(firstNameOf("WEBB, MARCUS")).toBe("Marcus");
  });

  it("title-cases what the timing system shouts", () => {
    expect(firstNameOf("MARCUS WEBB")).toBe("Marcus");
  });

  it("is empty for nothing usable", () => {
    expect(firstNameOf(null)).toBe("");
    expect(firstNameOf("   ")).toBe("");
  });
});
