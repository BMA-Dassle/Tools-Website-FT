import { describe, expect, it } from "vitest";
import {
  formatLap,
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
