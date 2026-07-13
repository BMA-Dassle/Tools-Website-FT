import { describe, expect, it } from "vitest";
import {
  getWeekPeriod,
  toDateStr,
  getDaysInPeriod,
  buildWeekTabs,
  formatDisplayDate,
} from "./week";

// Anchor dates use midday UTC so the ET calendar date is unambiguous
// regardless of the machine timezone the tests run in.

describe("getWeekPeriod (Wed–Tue, ET-aware)", () => {
  it("Sunday lands in the Wed–Tue period around it", () => {
    const p = getWeekPeriod(new Date("2026-07-12T16:00:00Z")); // Sun Jul 12 ET
    expect(toDateStr(p.start)).toBe("2026-07-08"); // Wed
    expect(toDateStr(p.end)).toBe("2026-07-14"); // Tue
  });

  it("Wednesday starts its own period", () => {
    const p = getWeekPeriod(new Date("2026-07-08T16:00:00Z"));
    expect(toDateStr(p.start)).toBe("2026-07-08");
    expect(toDateStr(p.end)).toBe("2026-07-14");
  });

  it("Tuesday closes the period", () => {
    const p = getWeekPeriod(new Date("2026-07-14T16:00:00Z"));
    expect(toDateStr(p.start)).toBe("2026-07-08");
    expect(toDateStr(p.end)).toBe("2026-07-14");
  });

  it("spans the November DST fall-back without gaining/losing a day", () => {
    const p = getWeekPeriod(new Date("2026-11-05T17:00:00Z")); // Thu Nov 5 ET; DST ended Nov 1
    expect(toDateStr(p.start)).toBe("2026-11-04");
    expect(toDateStr(p.end)).toBe("2026-11-10");
    expect(getDaysInPeriod(p.start, p.end)).toHaveLength(7);
  });
});

describe("getDaysInPeriod", () => {
  it("returns all 7 dates inclusive", () => {
    const p = getWeekPeriod(new Date("2026-07-12T16:00:00Z"));
    const days = getDaysInPeriod(p.start, p.end);
    expect(days).toEqual([
      "2026-07-08",
      "2026-07-09",
      "2026-07-10",
      "2026-07-11",
      "2026-07-12",
      "2026-07-13",
      "2026-07-14",
    ]);
  });
});

describe("buildWeekTabs", () => {
  it("last/current/next periods tile with no gaps or overlap", () => {
    const [last, current, next] = buildWeekTabs(new Date("2026-07-12T16:00:00Z"));
    expect(last.key).toBe("last");
    expect(current.key).toBe("current");
    expect(next.key).toBe("next");
    expect(toDateStr(last.period.start)).toBe("2026-07-01");
    expect(toDateStr(last.period.end)).toBe("2026-07-07");
    expect(toDateStr(current.period.start)).toBe("2026-07-08");
    expect(toDateStr(next.period.start)).toBe("2026-07-15");
    expect(toDateStr(next.period.end)).toBe("2026-07-21");
  });
});

describe("formatDisplayDate", () => {
  it("renders the calendar date independent of local timezone", () => {
    expect(formatDisplayDate("2026-07-12")).toBe("Sun, Jul 12");
  });
});
