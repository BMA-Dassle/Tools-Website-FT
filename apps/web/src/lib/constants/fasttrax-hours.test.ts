import { describe, it, expect } from "vitest";
import {
  FASTTRAX_LATE_OPEN_FROM,
  fasttraxHoursFor,
  fasttraxHoursGroups,
  fasttraxHoursOnDate,
  fasttraxOpeningHoursSpec,
  fasttraxWeekHours,
  formatHoursClock,
  formatHoursGroupLabel,
  formatHoursIso,
  formatHoursRange,
  formatHoursRangeTerse,
  weekdayOfIsoDate,
} from "./fasttrax-hours";

// 2026-08-07 = Fri (old era), 2026-08-10 = Mon (first day of the new era),
// 2026-08-11 = Tue (Mega day, new era).
const BEFORE = "2026-08-07";
const FIRST_DAY = "2026-08-10";
const AFTER = "2026-08-11";

const SUN = 0;
const MON = 1;
const TUE = 2;
const THU = 4;
const FRI = 5;
const SAT = 6;

describe("fasttrax hours — the 2026-08-10 Mon–Fri late open", () => {
  it("takes effect ON the effective date, not before", () => {
    expect(FASTTRAX_LATE_OPEN_FROM).toBe("2026-08-10");
    expect(fasttraxHoursFor(MON, "2026-08-09").openMinutes).toBe(13 * 60);
    expect(fasttraxHoursFor(MON, FIRST_DAY).openMinutes).toBe(15 * 60);
  });

  it("moves every weekday Mon–Fri to 3:00 PM", () => {
    for (const weekday of [MON, TUE, 3, THU, FRI]) {
      expect(fasttraxHoursFor(weekday, BEFORE).openMinutes).toBe(13 * 60);
      expect(fasttraxHoursFor(weekday, AFTER).openMinutes).toBe(15 * 60);
    }
  });

  it("leaves Sat + Sun at 11:00 AM", () => {
    for (const weekday of [SAT, SUN]) {
      expect(fasttraxHoursFor(weekday, BEFORE).openMinutes).toBe(11 * 60);
      expect(fasttraxHoursFor(weekday, AFTER).openMinutes).toBe(11 * 60);
    }
  });

  it("leaves every closing time untouched", () => {
    for (const date of [BEFORE, AFTER]) {
      const week = fasttraxWeekHours(date);
      expect(week[SUN].closeMinutes).toBe(23 * 60);
      expect(week[MON].closeMinutes).toBe(23 * 60);
      expect(week[THU].closeMinutes).toBe(23 * 60);
      expect(week[FRI].closeMinutes).toBe(24 * 60);
      expect(week[SAT].closeMinutes).toBe(24 * 60);
    }
  });
});

describe("fasttraxHoursOnDate", () => {
  it("resolves the date's own weekday and era", () => {
    expect(fasttraxHoursOnDate(BEFORE)).toMatchObject({
      weekday: FRI,
      day: "FRIDAY",
      openMinutes: 13 * 60,
      closeMinutes: 24 * 60,
    });
    expect(fasttraxHoursOnDate(AFTER)).toMatchObject({
      weekday: TUE,
      day: "TUESDAY",
      openMinutes: 15 * 60,
    });
  });

  it("returns null for an unparseable date", () => {
    expect(fasttraxHoursOnDate("not-a-date")).toBeNull();
  });
});

describe("weekdayOfIsoDate", () => {
  it("is TZ-independent (parsed as UTC calendar parts)", () => {
    expect(weekdayOfIsoDate("2026-08-09")).toBe(SUN);
    expect(weekdayOfIsoDate("2026-08-10")).toBe(MON);
    expect(weekdayOfIsoDate("2026-08-15")).toBe(SAT);
  });

  it("returns -1 for garbage", () => {
    expect(weekdayOfIsoDate("")).toBe(-1);
  });
});

describe("formatting", () => {
  it("renders 12-hour clock times, midnight as 12:00 AM", () => {
    expect(formatHoursClock(13 * 60)).toBe("1:00 PM");
    expect(formatHoursClock(15 * 60)).toBe("3:00 PM");
    expect(formatHoursClock(23 * 60)).toBe("11:00 PM");
    expect(formatHoursClock(24 * 60)).toBe("12:00 AM");
    expect(formatHoursClock(11 * 60)).toBe("11:00 AM");
    expect(formatHoursClock(12 * 60)).toBe("12:00 PM");
  });

  it("renders an en-dash range", () => {
    expect(formatHoursRange(fasttraxHoursFor(MON, AFTER))).toBe("3:00 PM – 11:00 PM");
    expect(formatHoursRange(fasttraxHoursFor(FRI, AFTER))).toBe("3:00 PM – 12:00 AM");
  });

  it("renders the terse SEO form, collapsing a shared meridiem", () => {
    expect(formatHoursRangeTerse(fasttraxHoursFor(MON, AFTER))).toBe("3-11 PM");
    expect(formatHoursRangeTerse(fasttraxHoursFor(FRI, AFTER))).toBe("3 PM-12 AM");
    expect(formatHoursRangeTerse(fasttraxHoursFor(SAT, AFTER))).toBe("11 AM-12 AM");
    expect(formatHoursRangeTerse(fasttraxHoursFor(SUN, AFTER))).toBe("11 AM-11 PM");
  });

  it("renders schema.org HH:MM, midnight as 00:00", () => {
    expect(formatHoursIso(15 * 60)).toBe("15:00");
    expect(formatHoursIso(23 * 60)).toBe("23:00");
    expect(formatHoursIso(24 * 60)).toBe("00:00");
  });
});

describe("grouping", () => {
  it("collapses the week Monday-first into Mon–Thu / Fri / Sat / Sun", () => {
    for (const date of [BEFORE, AFTER]) {
      const groups = fasttraxHoursGroups(date);
      expect(groups.map((g) => g.weekdays)).toEqual([[1, 2, 3, 4], [5], [6], [0]]);
      expect(groups.map(formatHoursGroupLabel)).toEqual(["Mon–Thu", "Fri", "Sat", "Sun"]);
    }
  });

  it("covers all seven days exactly once", () => {
    const days = fasttraxHoursGroups(AFTER).flatMap((g) => g.weekdays);
    expect([...days].sort()).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });
});

describe("fasttraxOpeningHoursSpec", () => {
  it("emits the pre-change schema", () => {
    expect(fasttraxOpeningHoursSpec(BEFORE)).toEqual([
      {
        "@type": "OpeningHoursSpecification",
        dayOfWeek: ["Monday", "Tuesday", "Wednesday", "Thursday"],
        opens: "13:00",
        closes: "23:00",
      },
      {
        "@type": "OpeningHoursSpecification",
        dayOfWeek: "Friday",
        opens: "13:00",
        closes: "00:00",
      },
      {
        "@type": "OpeningHoursSpecification",
        dayOfWeek: "Saturday",
        opens: "11:00",
        closes: "00:00",
      },
      {
        "@type": "OpeningHoursSpecification",
        dayOfWeek: "Sunday",
        opens: "11:00",
        closes: "23:00",
      },
    ]);
  });

  it("emits the post-change schema (Mon–Fri opens 15:00)", () => {
    const spec = fasttraxOpeningHoursSpec(AFTER);
    expect(spec[0]).toEqual({
      "@type": "OpeningHoursSpecification",
      dayOfWeek: ["Monday", "Tuesday", "Wednesday", "Thursday"],
      opens: "15:00",
      closes: "23:00",
    });
    expect(spec[1]).toEqual({
      "@type": "OpeningHoursSpecification",
      dayOfWeek: "Friday",
      opens: "15:00",
      closes: "00:00",
    });
    // Weekend untouched.
    expect(spec[2].opens).toBe("11:00");
    expect(spec[3].opens).toBe("11:00");
  });
});
