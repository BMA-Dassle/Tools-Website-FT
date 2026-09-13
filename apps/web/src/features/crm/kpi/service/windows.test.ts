import { describe, expect, it } from "vitest";
import {
  accountabilityWindow,
  dayPairs,
  dayOfWeek,
  elapsedDays,
  lastYearYmd,
  mondayOf,
  monthWindow,
  parseMonthKey,
  parseQuarterKey,
  quarterWindow,
  resolveKpiWindow,
  trailingWeeks,
  weekLabel,
} from "./windows";

/**
 * The windows every measure figure is computed over. These are the arithmetic
 * a dashboard gets silently wrong: a week that starts on the wrong day, a
 * "days elapsed" that counts tomorrow, a leap day that vanishes from the
 * last-year comparison.
 *
 * Every `now` is an EXPLICIT instant, and several are deliberately late in the
 * ET evening (after midnight UTC) — the runner is UTC, and a window derived
 * from `new Date()` on it lands on the next day. That is the same class of bug
 * as `bookedAt` spilling an ET evening into the next UTC day.
 */

/** 2026-09-12 19:30 ET = 2026-09-12T23:30Z — a Saturday, the prototype's clock. */
const SAT_EVENING = new Date("2026-09-12T23:30:00Z");
/** 2026-09-12 21:00 ET = 2026-09-13T01:00Z — the SAME ET day, the NEXT UTC day. */
const SAT_LATE = new Date("2026-09-13T01:00:00Z");

describe("month and quarter keys", () => {
  it("parses and rejects", () => {
    expect(parseMonthKey("2026-09")).toEqual({ year: 2026, month: 9 });
    expect(parseMonthKey("2026-13")).toBeNull();
    expect(parseMonthKey("2026-9")).toBeNull();
    expect(parseQuarterKey("2026-Q4")).toEqual({ year: 2026, quarter: 4 });
    expect(parseQuarterKey("2026-Q5")).toBeNull();
  });
});

describe("monthWindow", () => {
  it("spans the whole calendar month", () => {
    const w = monthWindow(2026, 9, SAT_EVENING);
    expect(w).toMatchObject({
      key: "2026-09",
      label: "September 2026",
      from: "2026-09-01",
      until: "2026-09-30",
      days: 30,
      year: 2026,
      months: [9],
    });
  });

  it("knows February in a leap year", () => {
    expect(monthWindow(2024, 2, SAT_EVENING).days).toBe(29);
    expect(monthWindow(2026, 2, SAT_EVENING).days).toBe(28);
  });

  it("counts days elapsed in ET, not UTC", () => {
    // Both instants are Saturday 12 September in Eastern time; the second is
    // already the 13th in UTC. A UTC-derived window would say 13.
    expect(monthWindow(2026, 9, SAT_EVENING).elapsed).toBe(12);
    expect(monthWindow(2026, 9, SAT_LATE).elapsed).toBe(12);
  });

  it("is 0 before the window and full once it is over", () => {
    expect(monthWindow(2026, 12, SAT_EVENING).elapsed).toBe(0);
    expect(monthWindow(2026, 8, SAT_EVENING).elapsed).toBe(31);
  });

  it("counts the first day as one day elapsed, not zero", () => {
    // Today's bookings count; a window that opened this morning is one day in.
    expect(elapsedDays("2026-09-12", "2026-09-30", SAT_EVENING)).toBe(1);
  });
});

describe("quarterWindow", () => {
  it("runs from the first of the first month to the last of the third", () => {
    const w = quarterWindow(2026, 4, SAT_EVENING);
    expect(w).toMatchObject({
      key: "2026-Q4",
      label: "Oct – Dec 2026",
      from: "2026-10-01",
      until: "2026-12-31",
      months: [10, 11, 12],
    });
    expect(w.days).toBe(92);
  });
});

describe("resolveKpiWindow", () => {
  it("prefers a quarter, then a month, then falls back to this ET month", () => {
    expect(resolveKpiWindow({ quarter: "2026-Q4", month: "2026-01" }, SAT_EVENING).key).toBe(
      "2026-Q4",
    );
    expect(resolveKpiWindow({ month: "2026-01" }, SAT_EVENING).key).toBe("2026-01");
    expect(resolveKpiWindow({}, SAT_EVENING).key).toBe("2026-09");
  });

  it("falls back rather than throwing on a hand-typed URL", () => {
    expect(resolveKpiWindow({ month: "not-a-month", quarter: "2026-Q9" }, SAT_EVENING).key).toBe(
      "2026-09",
    );
  });
});

describe("lastYearYmd", () => {
  it("is the same calendar day one year back", () => {
    expect(lastYearYmd("2026-09-12")).toBe("2025-09-12");
  });

  it("clamps 29 February into a non-leap year instead of rolling to 1 March", () => {
    expect(lastYearYmd("2024-02-29")).toBe("2023-02-28");
  });
});

describe("dayPairs", () => {
  it("pairs every day of the window with its last-year twin", () => {
    const pairs = dayPairs({ from: "2026-09-01", days: 30 });
    expect(pairs).toHaveLength(30);
    expect(pairs[0]).toEqual({ day: 1, date: "2026-09-01", lastYear: "2025-09-01" });
    expect(pairs[29]).toEqual({ day: 30, date: "2026-09-30", lastYear: "2025-09-30" });
  });
});

describe("weeks", () => {
  it("mondayOf pulls back to Monday, and Sunday belongs to the week that just ended", () => {
    expect(dayOfWeek("2026-09-13")).toBe(0); // Sunday
    expect(mondayOf("2026-09-13")).toBe("2026-09-07");
    expect(mondayOf("2026-09-07")).toBe("2026-09-07"); // Monday is its own
    expect(mondayOf("2026-09-12")).toBe("2026-09-07"); // Saturday
  });

  it("labels a week, and names the second month when it straddles one", () => {
    expect(weekLabel("2026-09-07", "2026-09-13")).toBe("Sep 7 – 13");
    expect(weekLabel("2026-09-28", "2026-10-04")).toBe("Sep 28 – Oct 4");
  });

  it("this week is Monday to Sunday, containing the prototype's Saturday", () => {
    const w = accountabilityWindow("week", SAT_EVENING);
    expect(w.from).toBe("2026-09-07");
    expect(w.until).toBe("2026-09-13");
    expect(w.label).toBe("Week of Sep 7 – 13");
    expect(w.weeks).toBe(1);
    // Saturday: one whole day (Sunday) is still to come.
    expect(w.workingDaysLeft).toBe(1);
  });

  it("last week is the seven days before this one, and is over", () => {
    const w = accountabilityWindow("last", SAT_EVENING);
    expect(w.from).toBe("2026-08-31");
    expect(w.until).toBe("2026-09-06");
    expect(w.workingDaysLeft).toBe(0);
    expect(w.weeks).toBe(1);
  });

  it("four weeks ends with the current week and scales targets by four", () => {
    const w = accountabilityWindow("4w", SAT_EVENING);
    expect(w.from).toBe("2026-08-17");
    expect(w.until).toBe("2026-09-13");
    expect(w.weeks).toBe(4);
  });

  it("does not roll into the next week for an ET evening that is already tomorrow in UTC", () => {
    expect(accountabilityWindow("week", SAT_LATE).from).toBe("2026-09-07");
  });

  it("trailingWeeks is four Monday-to-Sunday weeks, oldest first", () => {
    const weeks = trailingWeeks(SAT_EVENING);
    expect(weeks).toHaveLength(4);
    expect(weeks[0]).toEqual({ from: "2026-08-17", until: "2026-08-23" });
    expect(weeks[3]).toEqual({ from: "2026-09-07", until: "2026-09-13" });
  });
});
