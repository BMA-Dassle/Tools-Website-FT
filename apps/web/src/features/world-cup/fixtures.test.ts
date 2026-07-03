import { describe, expect, it } from "vitest";
import {
  WORLD_CUP_ENDS_AT_MS,
  WORLD_CUP_FIXTURES,
  WORLD_CUP_POPUP_STARTS_AT_MS,
  findFixture,
  fixtureForBookedAt,
  fixtureKickoffMs,
  fixtureLabel,
  fixtureMatchesBookedAt,
  fixturesOn,
  isWorldCupSlug,
  upcomingFixtures,
  weekendBand,
  worldCupPopupActive,
  worldCupSlugForDate,
  worldCupWindowActive,
} from "./fixtures";

const ET = (s: string) => Date.parse(s); // explicit-offset strings only — TZ-independent

describe("WORLD_CUP_FIXTURES", () => {
  it("has all 16 remaining matches with unique, stable ids", () => {
    expect(WORLD_CUP_FIXTURES).toHaveLength(16);
    expect(new Set(WORLD_CUP_FIXTURES.map((f) => f.id)).size).toBe(16);
  });

  it("ends with the final: July 19, 3 PM ET", () => {
    const final = WORLD_CUP_FIXTURES[WORLD_CUP_FIXTURES.length - 1];
    expect(final.id).toBe("final");
    expect(final.dateEt).toBe("2026-07-19");
    expect(final.kickoffHourEt).toBe(15);
  });

  it("is in chronological order (the picker renders it as-is)", () => {
    const times = WORLD_CUP_FIXTURES.map(fixtureKickoffMs);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });

  it("feature end = final kickoff + the 150-min window", () => {
    expect(WORLD_CUP_ENDS_AT_MS).toBe(ET("2026-07-19T17:30:00-04:00"));
  });
});

describe("weekendBand / worldCupSlugForDate", () => {
  it("maps Fri/Sat/Sun to the fri-sun band", () => {
    expect(weekendBand("2026-07-10")).toBe("fri-sun"); // Fri
    expect(weekendBand("2026-07-04")).toBe("fri-sun"); // Sat
    expect(weekendBand("2026-07-05")).toBe("fri-sun"); // Sun
  });

  it("maps Mon-Thu to the mon-thur band", () => {
    expect(weekendBand("2026-07-06")).toBe("mon-thur"); // Mon
    expect(weekendBand("2026-07-07")).toBe("mon-thur"); // Tue
    expect(weekendBand("2026-07-15")).toBe("mon-thur"); // Wed
    expect(weekendBand("2026-07-09")).toBe("mon-thur"); // Thu
  });

  it("resolves the seeded experience slug per band", () => {
    expect(worldCupSlugForDate("2026-07-06")).toBe("world-cup-vip-mon-thur");
    expect(worldCupSlugForDate("2026-07-19")).toBe("world-cup-vip-fri-sun");
  });
});

describe("isWorldCupSlug", () => {
  it("matches only the world-cup- prefix", () => {
    expect(isWorldCupSlug("world-cup-vip-mon-thur")).toBe(true);
    expect(isWorldCupSlug("world-cup-vip-fri-sun")).toBe(true);
    expect(isWorldCupSlug("vip-mon-thur")).toBe(false);
    expect(isWorldCupSlug("pizza-bowl-vip")).toBe(false);
    expect(isWorldCupSlug(null)).toBe(false);
    expect(isWorldCupSlug(undefined)).toBe(false);
  });
});

describe("kickoff instants + lookups", () => {
  it("fixtureKickoffMs is the ET kickoff", () => {
    expect(fixtureKickoffMs(findFixture("r16-6")!)).toBe(ET("2026-07-06T20:00:00-04:00"));
    expect(fixtureKickoffMs(findFixture("final")!)).toBe(ET("2026-07-19T15:00:00-04:00"));
  });

  it("fixturesOn returns a date's matches", () => {
    expect(fixturesOn("2026-07-11").map((f) => f.id)).toEqual(["qf-3", "qf-4"]);
    expect(fixturesOn("2026-07-12")).toEqual([]);
  });
});

describe("upcomingFixtures (kickoff − 15 min cutoff)", () => {
  it("keeps a match until 15 minutes before kickoff, then drops it", () => {
    const beforeCutoff = ET("2026-07-06T19:44:00-04:00");
    const atCutoff = ET("2026-07-06T19:45:00-04:00");
    expect(upcomingFixtures(beforeCutoff).map((f) => f.id)).toContain("r16-6");
    expect(upcomingFixtures(atCutoff).map((f) => f.id)).not.toContain("r16-6");
  });

  it("is empty once the final's cutoff passes", () => {
    expect(upcomingFixtures(ET("2026-07-19T14:45:00-04:00"))).toEqual([]);
  });

  it("preserves chronological order (first upcoming leads the picker)", () => {
    expect(upcomingFixtures(ET("2026-07-08T12:00:00-04:00"))[0]?.id).toBe("qf-1");
  });
});

describe("window + popup gates", () => {
  it("window is active through the knockout rounds", () => {
    expect(worldCupWindowActive(ET("2026-07-03T12:00:00-04:00"))).toBe(true);
    expect(worldCupWindowActive(ET("2026-07-19T14:00:00-04:00"))).toBe(true);
  });

  it("window closes when nothing is bookable (final kickoff cutoff)", () => {
    expect(worldCupWindowActive(ET("2026-07-19T15:00:00-04:00"))).toBe(false);
    expect(worldCupWindowActive(ET("2026-07-20T12:00:00-04:00"))).toBe(false);
  });

  it("popup starts EXACTLY when USA250's popup self-expires (7/5 00:00 ET)", () => {
    expect(WORLD_CUP_POPUP_STARTS_AT_MS).toBe(ET("2026-07-05T00:00:00-04:00"));
    expect(worldCupPopupActive(ET("2026-07-04T23:59:59-04:00"))).toBe(false);
    expect(worldCupPopupActive(ET("2026-07-05T00:00:00-04:00"))).toBe(true);
    expect(worldCupPopupActive(ET("2026-07-19T15:00:00-04:00"))).toBe(false);
  });
});

describe("fixtureMatchesBookedAt (ET-exact kickoff matching)", () => {
  const usaBelgium = findFixture("r16-6")!;

  it("accepts the exact kickoff in offset form", () => {
    expect(fixtureMatchesBookedAt(usaBelgium, "2026-07-06T20:00:00-04:00")).toBe(true);
  });

  it("accepts the exact kickoff in UTC (Z) form — QAMF offsets vary", () => {
    expect(fixtureMatchesBookedAt(usaBelgium, "2026-07-07T00:00:00Z")).toBe(true);
  });

  it("rejects off-kickoff starts, even 15 minutes late", () => {
    expect(fixtureMatchesBookedAt(usaBelgium, "2026-07-06T20:15:00-04:00")).toBe(false);
    expect(fixtureMatchesBookedAt(usaBelgium, "2026-07-06T19:00:00-04:00")).toBe(false);
    expect(fixtureMatchesBookedAt(usaBelgium, "2026-07-07T20:00:00-04:00")).toBe(false);
  });

  it("fixtureForBookedAt finds the right match (and null off-window)", () => {
    expect(fixtureForBookedAt("2026-07-06T20:00:00-04:00")?.id).toBe("r16-6");
    expect(fixtureForBookedAt("2026-07-06T15:00:00-04:00")?.id).toBe("r16-5");
    expect(fixtureForBookedAt("2026-07-06T18:00:00-04:00")).toBeNull();
    expect(fixtureForBookedAt("not-a-date")).toBeNull();
  });
});

describe("labels", () => {
  it("shows real teams when known, round + TBD otherwise", () => {
    expect(fixtureLabel(findFixture("r16-6")!)).toBe("USA vs Belgium");
    expect(fixtureLabel(findFixture("qf-1")!)).toBe("Quarterfinal — Teams TBD");
    expect(fixtureLabel(findFixture("final")!)).toBe("Final — Teams TBD");
  });
});
