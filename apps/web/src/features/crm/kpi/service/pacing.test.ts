import { describe, expect, it } from "vitest";
import {
  bookedToDate,
  buildPacing,
  deltaPct,
  lastYearFinished,
  lastYearToDate,
  median,
  neededPerDayCents,
  pacingFor,
} from "./pacing";
import { dayPairs } from "./windows";

/**
 * The pacing series. The two things that go wrong here are the cumulative
 * (a running total that resets, or one that keeps running past today) and the
 * last-year pairing (comparing day 12 against last year's WHOLE month, which
 * flatters every figure on the dashboard).
 */

const WINDOW = { from: "2026-09-01", days: 30, elapsed: 12 };

function money(pairs: [string, number][]): Map<string, number> {
  return new Map(pairs);
}

describe("buildPacing", () => {
  const series = buildPacing({
    pairs: dayPairs(WINDOW),
    byDay: money([
      ["2026-09-01", 10_000],
      ["2026-09-05", 5_000],
      ["2026-09-12", 1_000],
      // Booked on the 20th — after today. Must NOT appear.
      ["2026-09-20", 999_999],
    ]),
    lastYearByDay: money([
      ["2025-09-01", 8_000],
      ["2025-09-12", 2_000],
      ["2025-09-25", 40_000],
    ]),
    elapsed: 12,
    goalCents: 50_000,
  });

  it("accumulates day by day", () => {
    expect(series.points[0].tyCents).toBe(10_000);
    expect(series.points[4].tyCents).toBe(15_000);
    expect(series.points[11].tyCents).toBe(16_000);
  });

  it("stops this year's line after today instead of running it flat", () => {
    // A flat tail reads as "we stopped selling", which is a claim about days
    // that have not happened yet.
    expect(series.points[11].tyCents).toBe(16_000);
    expect(series.points[12].tyCents).toBeNull();
    expect(series.points[29].tyCents).toBeNull();
  });

  it("never counts a booking made after today, even though the row exists", () => {
    expect(bookedToDate(series)).toBe(16_000);
  });

  it("keeps last year's line running the whole window", () => {
    expect(series.points[29].lyCents).toBe(50_000);
    expect(lastYearFinished(series)).toBe(50_000);
  });

  it("reads last year on the SAME day of the window, not its finished total", () => {
    // Day 12 last year: 8,000 + 2,000. The finished month was 50,000 — using
    // that as the "vs LY" denominator is the flattering mistake.
    expect(lastYearToDate(series)).toBe(10_000);
  });

  it("reports the day the line stops", () => {
    expect(series.todayDay).toBe(12);
    expect(series.days).toBe(30);
  });
});

describe("edges", () => {
  it("a window that has not started has no this-year points at all", () => {
    const s = pacingFor(
      { from: "2026-12-01", days: 31, elapsed: 0 },
      money([]),
      money([["2025-12-01", 5_000]]),
      1_000,
    );
    expect(s.todayDay).toBe(0);
    expect(s.points.every((p) => p.tyCents === null)).toBe(true);
    expect(bookedToDate(s)).toBe(0);
    expect(lastYearToDate(s)).toBe(0);
  });

  it("a finished window runs to the last day", () => {
    const s = pacingFor(
      { from: "2026-08-01", days: 31, elapsed: 31 },
      money([["2026-08-31", 7_000]]),
      money([]),
      0,
    );
    expect(s.todayDay).toBe(31);
    expect(s.points[30].tyCents).toBe(7_000);
  });
});

describe("neededPerDayCents", () => {
  const base = { from: "2026-09-01", days: 30, elapsed: 12 };

  it("spreads the shortfall over the days that are left", () => {
    const s = pacingFor(base, money([["2026-09-01", 10_000]]), money([]), 100_000);
    // 90,000 short over 18 remaining days.
    expect(neededPerDayCents(s)).toEqual({ cents: 5_000, days: 18 });
  });

  it("asks for nothing once the goal is met", () => {
    const s = pacingFor(base, money([["2026-09-01", 200_000]]), money([]), 100_000);
    expect(neededPerDayCents(s)).toEqual({ cents: 0, days: 18 });
  });

  it("never divides by a window that is over", () => {
    const s = pacingFor(
      { from: "2026-08-01", days: 31, elapsed: 31 },
      money([]),
      money([]),
      100_000,
    );
    expect(neededPerDayCents(s)).toEqual({ cents: 0, days: 0 });
  });
});

describe("deltaPct", () => {
  it("is a whole percent against last year", () => {
    expect(deltaPct(120, 100)).toBe(20);
    expect(deltaPct(80, 100)).toBe(-20);
  });

  it("is null — not infinity — when last year was zero", () => {
    expect(deltaPct(500, 0)).toBeNull();
  });
});

describe("median", () => {
  it("is the middle of an odd list and the mean of the middle two of an even one", () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(median([1, 2, 3, 4])).toBe(3);
  });

  it("does not mutate its input", () => {
    const xs = [3, 1, 2];
    median(xs);
    expect(xs).toEqual([3, 1, 2]);
  });

  it("is null for an empty list, not zero", () => {
    // Zero would read as "we answer instantly", which is the opposite of
    // "nobody has been answered yet".
    expect(median([])).toBeNull();
  });
});
