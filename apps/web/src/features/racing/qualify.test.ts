import { describe, expect, it } from "vitest";
import {
  formatLap,
  nextLevelTarget,
  qualifiesFor,
  QUALIFY_INTERMEDIATE_BLUE,
  QUALIFY_INTERMEDIATE_RED,
  QUALIFY_PRO_BLUE,
  QUALIFY_PRO_RED,
} from "./qualify";

describe("qualifiesFor", () => {
  it("awards Pro at or under the Pro cutoff", () => {
    expect(qualifiesFor(QUALIFY_PRO_BLUE, "Blue Track")).toBe("Pro");
    expect(qualifiesFor(QUALIFY_PRO_BLUE - 1, "Blue Track")).toBe("Pro");
    expect(qualifiesFor(QUALIFY_PRO_RED, "Red Track")).toBe("Pro");
  });

  it("awards Intermediate between the two cutoffs", () => {
    expect(qualifiesFor(QUALIFY_PRO_BLUE + 1, "Blue Track")).toBe("Intermediate");
    expect(qualifiesFor(QUALIFY_INTERMEDIATE_BLUE, "Blue Track")).toBe("Intermediate");
  });

  it("awards nothing above the Intermediate cutoff", () => {
    expect(qualifiesFor(QUALIFY_INTERMEDIATE_BLUE + 1, "Blue Track")).toBeNull();
    expect(qualifiesFor(QUALIFY_INTERMEDIATE_RED + 1, "Red Track")).toBeNull();
  });

  it("uses the per-track cutoffs — the tracks are different lengths", () => {
    const lap = 43_000; // qualifies on Red, not on Blue
    expect(qualifiesFor(lap, "Red Track")).toBe("Intermediate");
    expect(qualifiesFor(lap, "Blue Track")).toBeNull();
  });

  it("matches the track name loosely, however the upstream spells it", () => {
    for (const name of ["blue", "Blue Track", "Blue Starter", "BLUE"]) {
      expect(qualifiesFor(QUALIFY_PRO_BLUE - 100, name)).toBe("Pro");
    }
  });

  it("treats an unrecognised track as RED — the conservative direction", () => {
    // Red's cutoffs are slower, so a mis-detected track can only under-award,
    // never hand somebody a level they did not earn.
    const lap = 42_000;
    expect(qualifiesFor(lap, "")).toBe("Intermediate"); // Red rules
    expect(qualifiesFor(lap, "Blue Track")).toBeNull();
  });

  it("never qualifies a MEGA lap", () => {
    // The combined circuit is ~twice the length; comparing its laps to a single
    // track's cutoff would be measuring the wrong distance.
    expect(qualifiesFor(30_000, "Mega Track")).toBeNull();
    expect(qualifiesFor(30_000, "mega")).toBeNull();
  });

  it("rejects nonsense lap times", () => {
    expect(qualifiesFor(0, "Blue Track")).toBeNull();
    expect(qualifiesFor(-5, "Blue Track")).toBeNull();
    expect(qualifiesFor(NaN, "Blue Track")).toBeNull();
  });
});

describe("formatLap", () => {
  it("renders milliseconds as seconds with three decimals", () => {
    expect(formatLap(36_785)).toBe("36.785");
    expect(formatLap(32_500)).toBe("32.500");
  });
});

describe("nextLevelTarget", () => {
  it("gives a Starter grid the Intermediate cutoff for their track", () => {
    expect(nextLevelTarget("blue", "Starter")).toEqual({
      level: "Intermediate",
      ms: QUALIFY_INTERMEDIATE_BLUE,
    });
    expect(nextLevelTarget("Red Track", "Starter")).toEqual({
      level: "Intermediate",
      ms: QUALIFY_INTERMEDIATE_RED,
    });
  });

  it("gives an Intermediate grid the Pro cutoff", () => {
    expect(nextLevelTarget("blue", "Intermediate")).toEqual({
      level: "Pro",
      ms: QUALIFY_PRO_BLUE,
    });
    expect(nextLevelTarget("red", "Intermediate (2)")).toEqual({
      level: "Pro",
      ms: QUALIFY_PRO_RED,
    });
  });

  it("shows nothing to a Pro grid — there is nowhere above it", () => {
    expect(nextLevelTarget("blue", "Pro")).toBeNull();
    expect(nextLevelTarget("red", "Junior Pro")).toBeNull();
  });

  it("shows nothing on MEGA — the combined circuit has no comparable cutoff", () => {
    expect(nextLevelTarget("mega", "Starter")).toBeNull();
    expect(nextLevelTarget("Mega Track", "Intermediate")).toBeNull();
  });

  it("shows nothing for a session type it cannot read", () => {
    expect(nextLevelTarget("blue", null)).toBeNull();
    expect(nextLevelTarget("blue", "")).toBeNull();
    expect(nextLevelTarget("blue", "Corporate Event")).toBeNull();
  });

  it("agrees with qualifiesFor — the target shown IS the line that decides", () => {
    // The point of sharing the constants: a racer told to beat 41.000 and then
    // judged against a different number would be a broken promise.
    for (const track of ["blue", "red"]) {
      const t = nextLevelTarget(track, "Starter")!;
      expect(qualifiesFor(t.ms, track)).toBe("Intermediate");
      expect(qualifiesFor(t.ms + 1, track)).toBeNull();
    }
  });
});
