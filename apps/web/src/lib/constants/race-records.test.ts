import { describe, it, expect, afterEach, vi } from "vitest";
import { recordsStartDate, RECORD_TRACKS } from "./race-records";

/** Freeze the clock at a real instant, expressed in UTC. 15:00Z is mid-morning
 *  ET on either side of a DST change, so a frozen date never lands on the
 *  previous ET day by accident. */
function freeze(iso: string) {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(iso));
}

afterEach(() => {
  vi.useRealTimers();
});

describe("recordsStartDate", () => {
  it("opens every window at 6am, the racing day's own boundary", () => {
    freeze("2026-08-17T15:00:00Z");
    for (const r of ["today", "week", "month", "year", "alltime"] as const) {
      expect(recordsStartDate(r)).toMatch(/ 06:00:00$/);
    }
  });

  it("today is the ET calendar date", () => {
    freeze("2026-08-17T15:00:00Z");
    expect(recordsStartDate("today")).toBe("2026-8-17 06:00:00");
  });

  it("week is a trailing seven days, not since Sunday", () => {
    // 2026-08-17 is a Monday. Week-to-date would be the 16th and would leave a
    // Monday board with one evening of racing on it; trailing-7 is the 10th.
    freeze("2026-08-17T15:00:00Z");
    expect(recordsStartDate("week")).toBe("2026-8-10 06:00:00");
  });

  it("week walks back across a month boundary", () => {
    freeze("2026-09-03T15:00:00Z");
    expect(recordsStartDate("week")).toBe("2026-8-27 06:00:00");
  });

  it("week walks back across a year boundary", () => {
    freeze("2026-01-04T15:00:00Z");
    expect(recordsStartDate("week")).toBe("2025-12-28 06:00:00");
  });

  it("week walks back across a leap day", () => {
    freeze("2028-03-04T15:00:00Z");
    expect(recordsStartDate("week")).toBe("2028-2-26 06:00:00");
  });

  it("month is month-to-date and year is year-to-date, unchanged", () => {
    freeze("2026-08-17T15:00:00Z");
    expect(recordsStartDate("month")).toBe("2026-8-1 06:00:00");
    expect(recordsStartDate("year")).toBe("2026-1-1 06:00:00");
  });

  it("uses the ET date, not UTC's — the hours they disagree are the ones that matter", () => {
    // 03:00Z on the 18th is 23:00 ET on the 17th: still the 17th's race night.
    freeze("2026-08-18T03:00:00Z");
    expect(recordsStartDate("today")).toBe("2026-8-17 06:00:00");
  });
});

describe("RECORD_TRACKS", () => {
  it("covers all three tracks, so no results board can ask for a track with no catalog", () => {
    expect(RECORD_TRACKS.map((t) => t.key).sort()).toEqual(["blue", "mega", "red"]);
  });

  it("gives every category the ids the upstream needs", () => {
    for (const track of RECORD_TRACKS) {
      for (const c of [...track.adult, ...track.junior]) {
        expect(c.rscId, `${track.key} ${c.label} rscId`).toBeTruthy();
        expect(c.scgId, `${track.key} ${c.label} scgId`).toBeTruthy();
      }
    }
  });
});
