import { describe, expect, it } from "vitest";
import type { MonthlyGoalRow, PacingSeries, RepKpi } from "~/features/crm/kpi/contracts";
import { REVENUE_BASIS } from "~/features/crm/kpi/contracts";
import {
  attributionNote,
  axisTicks,
  basisTitle,
  dayAtX,
  dayTicksFor,
  deltaMark,
  deltaOf,
  kpiSubtitle,
  linePath,
  monthlyGeometry,
  needLabel,
  needPerDay,
  niceMax,
  pacingGeometry,
  pctOf,
  responseLabel,
  shortDay,
  sourceSummary,
  sparkGeometry,
} from "./model";

/**
 * The charts' arithmetic. An SVG that computes its scale inside JSX is a chart
 * nobody can assert on, and the things that actually go wrong with a chart are
 * arithmetic: an axis that clips the tallest bar, a "today" marker on the wrong
 * day, a percentage that divides by zero.
 */

function series(over: Partial<PacingSeries> = {}): PacingSeries {
  const points = Array.from({ length: 30 }, (_, i) => ({
    day: i + 1,
    date: `2026-09-${String(i + 1).padStart(2, "0")}`,
    tyCents: i < 12 ? (i + 1) * 1_000_00 : null,
    lyCents: (i + 1) * 900_00,
  }));
  return { points, todayDay: 12, goalCents: 5_000_000, days: 30, ...over };
}

describe("deltaOf", () => {
  it("is a signed direction with an absolute percentage", () => {
    expect(deltaOf(120, 100)).toEqual({ pct: 20, dir: "up", comparable: true });
    expect(deltaOf(80, 100)).toEqual({ pct: 20, dir: "down", comparable: true });
    expect(deltaOf(100, 100)).toEqual({ pct: 0, dir: "flat", comparable: true });
  });

  it("says there is nothing to compare rather than claiming a 100% rise", () => {
    // A zero denominator is not infinite growth; the tile prints "no last-year
    // figure" instead of a confident ▲.
    expect(deltaOf(5_000, 0)).toEqual({ pct: 0, dir: "flat", comparable: false });
  });

  it("marks each direction", () => {
    expect(deltaMark("up")).toBe("▲");
    expect(deltaMark("down")).toBe("▼");
    expect(deltaMark("flat")).toBe("•");
  });
});

describe("pctOf", () => {
  it("is 0 rather than NaN or Infinity with no denominator", () => {
    expect(pctOf(5, 0)).toBe(0);
    expect(pctOf(1, 3)).toBe(33);
  });
});

describe("basisTitle", () => {
  it("puts the money's definition where the owner can read it", () => {
    const t = basisTitle("Confirmed projects.", "square");
    expect(t).toContain("Confirmed projects.");
    expect(t).toContain(REVENUE_BASIS.square);
  });

  it("gives each of the three moneys a different sentence", () => {
    // The old portal dashboard conflated these; the whole point is that they
    // read differently on the page.
    const bases = [REVENUE_BASIS.bmi, REVENUE_BASIS.contract, REVENUE_BASIS.square];
    expect(new Set(bases).size).toBe(3);
  });
});

describe("niceMax", () => {
  it("rounds up to a round number and never below the data", () => {
    expect(niceMax(97_000)).toBeGreaterThanOrEqual(97_000);
    expect(niceMax(100)).toBeGreaterThanOrEqual(100);
    expect(niceMax(12_345_678)).toBeGreaterThanOrEqual(12_345_678);
  });

  it("is a sensible round value, not just anything bigger", () => {
    expect(niceMax(100_000)).toBe(100_000);
    expect(niceMax(101_000)).toBe(125_000);
  });

  it("does not collapse on zero or a nonsense input", () => {
    expect(niceMax(0)).toBeGreaterThan(0);
    expect(niceMax(Number.NaN)).toBeGreaterThan(0);
  });

  it("axisTicks spans 0 to max inclusive", () => {
    expect(axisTicks(100_000, 4)).toEqual([0, 25_000, 50_000, 75_000, 100_000]);
  });
});

describe("dayTicksFor", () => {
  it("labels every day of a short window", () => {
    expect(dayTicksFor(5)).toEqual([1, 2, 3, 4, 5]);
  });

  it("thins a long window to at most seven, keeping the ends", () => {
    const t = dayTicksFor(30);
    expect(t.length).toBeLessThanOrEqual(7);
    expect(t[0]).toBe(1);
    expect(t[t.length - 1]).toBe(30);
  });

  it("thins a quarter without collisions", () => {
    const t = dayTicksFor(92);
    expect(t[0]).toBe(1);
    expect(t[t.length - 1]).toBe(92);
    expect(new Set(t).size).toBe(t.length);
  });
});

describe("linePath", () => {
  it("draws a line through the points", () => {
    expect(
      linePath(
        [1, 2],
        (i) => i * 10,
        (v) => v,
      ),
    ).toBe("M0.0,1.0 L10.0,2.0");
  });

  it("BREAKS at a null instead of joining across it", () => {
    // Joining across the gap would draw a line through days that have no data.
    const p = linePath(
      [1, null, 3],
      (i) => i * 10,
      (v) => v,
    );
    expect(p).toBe("M0.0,1.0 M20.0,3.0");
    expect(p).not.toContain("L20.0");
  });

  it("is empty for no points at all", () => {
    expect(
      linePath(
        [],
        (i) => i,
        (v) => v,
      ),
    ).toBe("");
  });
});

describe("pacingGeometry", () => {
  const geo = pacingGeometry(series());

  it("puts the axis above the tallest of goal, this year and last year", () => {
    expect(geo.max).toBeGreaterThanOrEqual(5_000_000);
    expect(geo.max).toBeGreaterThanOrEqual(30 * 900_00);
  });

  it("stops this year's path at today and shades what is left", () => {
    expect(geo.todayDay).toBe(12);
    expect(geo.todayX).not.toBeNull();
    expect(geo.tyPath.split("L").length - 1).toBe(11); // 12 points, 11 segments
  });

  it("reads this year and last year on the SAME day", () => {
    expect(geo.tyNow).toBe(12 * 1_000_00);
    expect(geo.lyNow).toBe(12 * 900_00);
    expect(geo.lyFinished).toBe(30 * 900_00);
  });

  it("closes the area back to the baseline at today, not at the month end", () => {
    expect(geo.areaPath).toContain("Z");
    expect(geo.areaPath.startsWith(geo.tyPath)).toBe(true);
  });

  it("draws no goal line when no goal is set", () => {
    expect(pacingGeometry(series({ goalCents: 0 })).goalY).toBeNull();
  });

  it("handles a window that has not started: no today marker, no area", () => {
    const s = series({
      todayDay: 0,
      points: series().points.map((p) => ({ ...p, tyCents: null })),
    });
    const g = pacingGeometry(s);
    expect(g.todayX).toBeNull();
    expect(g.areaPath).toBe("");
    expect(g.tyNow).toBe(0);
  });

  it("maps an x back to the right day, clamped to the window", () => {
    expect(dayAtX(geo, geo.xOf(7), 30)).toBe(7);
    expect(dayAtX(geo, -9999, 30)).toBe(1);
    expect(dayAtX(geo, 9999, 30)).toBe(30);
  });
});

describe("monthlyGeometry", () => {
  const rows: MonthlyGoalRow[] = Array.from({ length: 12 }, (_, i) => ({
    month: i + 1,
    label: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][i],
    goalCents: 100_000 * (i + 1),
    lastYearCents: 90_000 * (i + 1),
    actualCents: i < 8 ? 95_000 * (i + 1) : null,
  }));
  const geo = monthlyGeometry(rows);

  it("gives every month a group, in order", () => {
    expect(geo.bars).toHaveLength(12);
    expect(geo.bars.map((b) => b.month)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  it("never clips the tallest bar", () => {
    expect(geo.max).toBeGreaterThanOrEqual(100_000 * 12);
    for (const b of geo.bars) expect(b.goal.y).toBeGreaterThanOrEqual(geo.box.top);
  });

  it("leaves a month that has not started with NO actual bar, not a zero one", () => {
    // Zero claims we sold nothing; absence says the month has not happened.
    expect(geo.bars[7].actual).not.toBeNull();
    expect(geo.bars[8].actual).toBeNull();
  });

  it("keeps the three marks inside their group and in order", () => {
    const b = geo.bars[0];
    expect(b.ly.x).toBeLessThan(b.goal.x);
    expect(b.goal.x).toBeLessThan(b.actual!.x);
    expect(b.ly.x + b.ly.w).toBeLessThanOrEqual(b.goal.x);
  });

  it("anchors every bar to the baseline", () => {
    const base = geo.yOf(0);
    for (const b of geo.bars) expect(b.ly.y + b.ly.h).toBeCloseTo(base, 5);
  });
});

describe("sparkGeometry", () => {
  it("is null for a series too short to draw", () => {
    expect(sparkGeometry([])).toBeNull();
    expect(sparkGeometry([5])).toBeNull();
  });

  it("draws a flat line for a flat series rather than dividing by zero", () => {
    const g = sparkGeometry([4, 4, 4]);
    expect(g).not.toBeNull();
    expect(Number.isFinite(g!.lastY)).toBe(true);
  });

  it("ends on the last value", () => {
    const g = sparkGeometry([1, 2, 3])!;
    expect(g.lastX).toBeCloseTo(g.w - 2, 5);
  });
});

describe("screen text", () => {
  const team = (over: Partial<RepKpi> = {}): RepKpi => ({
    repId: null,
    slug: "team",
    firstName: "Team",
    displayName: "Team",
    initials: "··",
    bookedCents: 1_000_000,
    lastYearToDateCents: 900_000,
    lastYearFullCents: 2_000_000,
    quotedCents: 0,
    goalCents: 2_800_000,
    leads: 10,
    confirmed: 3,
    ...over,
  });

  it("kpiSubtitle reads like the prototype's", () => {
    expect(kpiSubtitle("September 2026", "All salespeople", 12, 30)).toBe(
      "September 2026 · All salespeople · 12 of 30 days",
    );
  });

  it("needPerDay spreads the shortfall over the days left", () => {
    expect(needPerDay(team(), 12, 30)).toEqual({ cents: 100_000, days: 18 });
  });

  it("asks for nothing once the goal is met, and says so", () => {
    const met = needPerDay(team({ bookedCents: 3_000_000 }), 12, 30);
    expect(met.cents).toBe(0);
    expect(needLabel(met)).toContain("Goal met");
  });

  it("never divides by a closed window", () => {
    const closed = needPerDay(team(), 30, 30);
    expect(closed).toEqual({ cents: 0, days: 0 });
    expect(needLabel(closed)).toBe("Window closed");
  });

  it("sourceSummary lists the busiest sources and says when there are none", () => {
    expect(
      sourceSummary([
        { label: "Web form", leads: 46 },
        { label: "Last year", leads: 22 },
        { label: "Phone", leads: 0 },
      ]),
    ).toBe("46 web form · 22 last year");
    expect(sourceSummary([])).toContain("No leads");
  });

  it("attributionNote is SILENT when everything matched", () => {
    expect(attributionNote({ projects: 40, exact: 40, fuzzy: 0, none: 0 })).toBeNull();
    expect(attributionNote({ projects: 0, exact: 0, fuzzy: 0, none: 0 })).toBeNull();
  });

  it("attributionNote names the gap when there is one", () => {
    const n = attributionNote({ projects: 40, exact: 30, fuzzy: 6, none: 4 });
    expect(n).toContain("4 in no salesperson's row");
    expect(n).toContain("6 matched by name");
    expect(n).toContain("counted in the team total");
  });

  it("responseLabel reads in minutes then hours", () => {
    expect(responseLabel(38)).toBe("38 min");
    expect(responseLabel(130)).toBe("2 h 10 m");
    expect(responseLabel(120)).toBe("2 h");
    expect(responseLabel(null)).toBe("—");
  });

  it("shortDay formats an axis label", () => {
    expect(shortDay("2026-09-03")).toBe("Sep 3");
  });
});
