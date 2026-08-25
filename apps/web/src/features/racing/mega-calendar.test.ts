import { describe, expect, it } from "vitest";
import {
  MEGA_DAY_WINDOWS,
  isMegaDay,
  isMegaDayTodayET,
  megaDaysPhrase,
  megaWindowFor,
  megaWindowForWeekdayOn,
  megaWindowTodayET,
  megaWindowsOn,
  nextMegaDay,
} from "./mega-calendar";

/**
 * The Sep–Oct 2026 Mega Thursday season (owner 2026-08-25). Every date below
 * was checked against a real calendar, not inferred:
 *
 *   2026-09-02 Wed · 2026-09-03 Thu (first)  · 2026-09-08 Tue
 *   2026-10-29 Thu (last)          · 2026-10-31 Sat (window ends, not a Thu)
 *   2026-11-05 Thu (first Thursday after the season)
 */
const BEFORE_SEASON_THU = "2026-08-27";
const FIRST_MEGA_THU = "2026-09-03";
const MID_SEASON_THU = "2026-10-08";
const LAST_MEGA_THU = "2026-10-29";
const AFTER_SEASON_THU = "2026-11-05";

describe("Mega Tuesday — the standing window", () => {
  it("runs on a Tuesday before, during and after the Thursday season", () => {
    expect(isMegaDay("2026-08-25")).toBe(true); // before
    expect(isMegaDay("2026-09-08")).toBe(true); // during
    expect(isMegaDay("2026-11-03")).toBe(true); // after
  });

  it("never runs Mon/Wed/Fri/Sat/Sun", () => {
    for (const iso of ["2026-09-07", "2026-09-09", "2026-09-11", "2026-09-12", "2026-09-13"]) {
      expect(isMegaDay(iso)).toBe(false);
    }
  });
});

describe("Mega Thursday — the Sep 3 → end of October 2026 season", () => {
  it("does NOT run on a Thursday before the season opens", () => {
    expect(isMegaDay(BEFORE_SEASON_THU)).toBe(false);
  });

  it("runs from the very first day of the season", () => {
    expect(isMegaDay(FIRST_MEGA_THU)).toBe(true);
    expect(megaWindowFor(FIRST_MEGA_THU)?.label).toBe("Mega Thursday");
  });

  it("runs mid-season", () => {
    expect(isMegaDay(MID_SEASON_THU)).toBe(true);
  });

  it("runs on the last Thursday inside the window — `until` is INCLUSIVE", () => {
    expect(isMegaDay(LAST_MEGA_THU)).toBe(true);
  });

  it("stops on its own once the season ends — no edit required", () => {
    expect(isMegaDay(AFTER_SEASON_THU)).toBe(false);
    expect(isMegaDay("2026-11-12")).toBe(false);
    expect(isMegaDay("2027-09-03")).toBe(false); // next year's Sept, not a rerun
  });

  it("does not turn the season's non-Thursdays into Mega days", () => {
    // The window ends 10-31, a SATURDAY. An `until` compared without the
    // weekday check would have made that Saturday a Mega day.
    expect(isMegaDay("2026-10-31")).toBe(false);
    expect(isMegaDay("2026-09-02")).toBe(false); // Wed inside the season
    expect(isMegaDay("2026-10-30")).toBe(false); // Fri inside the season
  });
});

describe("date parsing", () => {
  it("reads a bare YYYY-MM-DD as a LOCAL day, not UTC", () => {
    // `new Date("2026-09-03")` is UTC midnight, which reads back as Wednesday
    // the 2nd in any US zone — the trap that once hid a package for a whole
    // Tuesday. If this regresses, the first Mega Thursday is not a Mega day.
    expect(isMegaDay("2026-09-03")).toBe(true);
  });

  it("accepts an ISO timestamp and keys off its date part", () => {
    expect(isMegaDay("2026-09-03T15:00:00.000Z")).toBe(true);
    expect(isMegaDay("2026-09-04T15:00:00.000Z")).toBe(false);
  });

  it("accepts a Date and reads its own local calendar day", () => {
    expect(isMegaDay(new Date(2026, 8, 3))).toBe(true); // month 8 = September
    expect(isMegaDay(new Date(2026, 8, 4))).toBe(false);
    expect(isMegaDay(new Date(2026, 7, 27))).toBe(false); // Thu, pre-season
  });

  it("refuses a date it cannot parse rather than guessing", () => {
    expect(isMegaDay("not-a-date")).toBe(false);
  });
});

describe("today in Eastern Time", () => {
  it("answers for the ET day, not the server's day", () => {
    // 2026-09-04 01:00 UTC is still 9 PM Thursday the 3rd in ET. A server
    // clocked in UTC has already rolled into Friday.
    const lateThursdayEt = new Date("2026-09-04T01:00:00Z");
    expect(isMegaDayTodayET(lateThursdayEt)).toBe(true);
    expect(megaWindowTodayET(lateThursdayEt)?.dayName).toBe("Thursday");
  });

  it("is not a Mega day once ET itself has rolled over", () => {
    const fridayEt = new Date("2026-09-04T13:00:00Z"); // 9 AM Fri ET
    expect(isMegaDayTodayET(fridayEt)).toBe(false);
  });
});

describe("megaWindowForWeekdayOn — for copy that names a weekday", () => {
  it("admits Thursday only while the season is open", () => {
    expect(megaWindowForWeekdayOn(4, "2026-09-02")).toBeNull(); // day before it opens
    expect(megaWindowForWeekdayOn(4, "2026-09-03")).not.toBeNull();
    expect(megaWindowForWeekdayOn(4, "2026-10-31")).not.toBeNull(); // last day of window
    expect(megaWindowForWeekdayOn(4, "2026-11-01")).toBeNull();
  });

  it("always admits Tuesday", () => {
    expect(megaWindowForWeekdayOn(2, "2026-08-01")?.label).toBe("Mega Tuesday");
    expect(megaWindowForWeekdayOn(2, "2027-03-01")?.label).toBe("Mega Tuesday");
  });

  it("never admits a weekday no window names", () => {
    expect(megaWindowForWeekdayOn(3, "2026-09-03")).toBeNull();
  });
});

describe("megaWindowsOn / megaDaysPhrase — what the schedule LOOKS like", () => {
  it("is Tuesdays alone outside the season", () => {
    expect(megaWindowsOn("2026-08-25").map((w) => w.dayName)).toEqual(["Tuesday"]);
    expect(megaDaysPhrase("2026-08-25")).toBe("Tuesdays");
    expect(megaDaysPhrase("2026-11-05")).toBe("Tuesdays");
  });

  it("picks up Thursdays for the season, in weekday order", () => {
    expect(megaWindowsOn("2026-09-03").map((w) => w.dayName)).toEqual(["Tuesday", "Thursday"]);
    expect(megaDaysPhrase("2026-09-03")).toBe("Tuesdays and Thursdays");
    expect(megaDaysPhrase("2026-10-31")).toBe("Tuesdays and Thursdays");
  });

  it("reverts the copy the day the season ends — nobody has to remember", () => {
    expect(megaDaysPhrase("2026-11-01")).toBe("Tuesdays");
  });
});

describe("nextMegaDay — for anything advertising a dated occurrence", () => {
  it("returns the day itself when it is already a Mega day", () => {
    expect(nextMegaDay("2026-09-03")).toEqual({
      isoDate: "2026-09-03",
      window: expect.objectContaining({ dayName: "Thursday" }),
    });
  });

  it("finds the Thursday, not the Tuesday, when Thursday comes first", () => {
    // From Wednesday 09-02 the next Mega day is Thursday the 3rd. A hardcoded
    // "next Tuesday" would advertise the 8th — five days late.
    expect(nextMegaDay("2026-09-02")?.isoDate).toBe("2026-09-03");
  });

  it("finds the Tuesday when Tuesday comes first", () => {
    // Friday 09-04 → Tuesday 09-08 beats Thursday 09-10.
    expect(nextMegaDay("2026-09-04")?.isoDate).toBe("2026-09-08");
  });

  it("skips a Thursday that falls outside the season", () => {
    // Wednesday 2026-11-04: Thursday the 5th is past the season, so the next
    // Mega day is Tuesday the 10th.
    expect(nextMegaDay("2026-11-04")?.isoDate).toBe("2026-11-10");
  });

  it("crosses a month boundary without tripping on DST", () => {
    // 2026-11-01 is the US DST fall-back. Walking from 10-30 must still land
    // on Tuesday 11-03.
    expect(nextMegaDay("2026-10-30")?.isoDate).toBe("2026-11-03");
  });

  it("refuses an unparseable date rather than guessing", () => {
    expect(nextMegaDay("nonsense")).toBeNull();
  });
});

describe("the window list itself", () => {
  it("names an explicit end for every limited run", () => {
    // `until` is REQUIRED on MegaDayWindow so a season cannot silently become
    // permanent. This asserts the intent, not just the type.
    const seasonal = MEGA_DAY_WINDOWS.filter((w) => w.from !== "0000-01-01");
    expect(seasonal.length).toBeGreaterThan(0);
    for (const w of seasonal) expect(w.until).toBeTruthy();
  });

  it("gives each weekday at most one window, so no date matches twice", () => {
    const weekdays = MEGA_DAY_WINDOWS.map((w) => w.weekday);
    expect(new Set(weekdays).size).toBe(weekdays.length);
  });
});
