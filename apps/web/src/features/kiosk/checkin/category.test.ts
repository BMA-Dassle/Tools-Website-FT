import { describe, expect, it } from "vitest";
import { resolveRaceClass, ageFromDobIso, JUNIOR_MAX_AGE } from "./category";

describe("race class resolution", () => {
  it("prefers an explicit category over dob", () => {
    expect(resolveRaceClass({ category: "junior", dobIso: "1990-01-01" })).toBe("junior");
    expect(resolveRaceClass({ category: "adult", dobIso: "2020-01-01" })).toBe("adult");
  });

  it("derives junior for a young child and adult for a grown adult", () => {
    // Stable for decades: a 1990 birthdate is adult, a very recent one is junior.
    expect(resolveRaceClass({ dobIso: "1990-06-15" })).toBe("adult");
    const recent = `${new Date().getFullYear() - 6}-06-15`;
    expect(resolveRaceClass({ dobIso: recent })).toBe("junior");
  });

  it("treats a 13–17-year-old as ADULT class, not junior (the isMinor trap)", () => {
    const fifteen = `${new Date().getFullYear() - 15}-01-01`;
    expect(resolveRaceClass({ dobIso: fifteen })).toBe("adult");
  });

  it("returns null when class is genuinely unknown", () => {
    expect(resolveRaceClass({})).toBeNull();
    expect(resolveRaceClass({ category: null, dobIso: null })).toBeNull();
    expect(resolveRaceClass({ dobIso: "not-a-date" })).toBeNull();
  });

  it("ageFromDobIso parses and rejects junk", () => {
    expect(ageFromDobIso("1990-01-01")).toBeGreaterThan(30);
    expect(ageFromDobIso(null)).toBeNull();
    expect(ageFromDobIso("")).toBeNull();
    expect(JUNIOR_MAX_AGE).toBe(13);
  });
});
