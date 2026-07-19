import { describe, expect, it } from "vitest";
import { addDaysYmd, earliestProbeMin, snapUp15 } from "./availability-window";

// FM weekday: open 11 AM (11), close 12 AM (24). Weekend: close 2 AM (26).
const WEEKDAY = { openHour: 11, closeHour: 24 };
const WEEKEND = { openHour: 11, closeHour: 26 };

describe("snapUp15", () => {
  it("snaps up to the next quarter", () => {
    expect(snapUp15(737)).toBe(750); // 12:17 → 12:30
    expect(snapUp15(750)).toBe(750); // already aligned
    expect(snapUp15(751)).toBe(765);
  });
});

describe("addDaysYmd", () => {
  it("adds across month and year boundaries", () => {
    expect(addDaysYmd("2026-07-31", 1)).toBe("2026-08-01");
    expect(addDaysYmd("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDaysYmd("2026-07-19", 0)).toBe("2026-07-19");
  });
});

describe("earliestProbeMin", () => {
  it("future date → opening time", () => {
    expect(
      earliestProbeMin({
        startDate: "2026-07-22",
        nowDateEt: "2026-07-19",
        nowMinutesEt: 737,
        leadMinutes: 15,
        ...WEEKDAY,
      }),
    ).toBe(11 * 60);
  });

  it("today at 12:17 PM with 15-min lead → 12:45 floor (the owner bug: 12:00 PM must not survive)", () => {
    const floor = earliestProbeMin({
      startDate: "2026-07-19",
      nowDateEt: "2026-07-19",
      nowMinutesEt: 12 * 60 + 17,
      leadMinutes: 15,
      ...WEEKDAY,
    });
    expect(floor).toBe(12 * 60 + 45); // 12:17 + 15 = 12:32 → snap 12:45
    expect(floor).toBeGreaterThan(12 * 60); // 12:00 PM excluded
  });

  it("kiosk ASAP (leadMinutes 0) floors to the next quarter only", () => {
    expect(
      earliestProbeMin({
        startDate: "2026-07-19",
        nowDateEt: "2026-07-19",
        nowMinutesEt: 14 * 60 + 18, // owner bug repro: "showed 2:00 PM at 2:18 PM"
        leadMinutes: 0,
        ...WEEKDAY,
      }),
    ).toBe(14 * 60 + 30);
  });

  it("today before opening → opening time, not now+lead", () => {
    expect(
      earliestProbeMin({
        startDate: "2026-07-20",
        nowDateEt: "2026-07-20",
        nowMinutesEt: 9 * 60, // 9 AM, opens 11
        leadMinutes: 15,
        ...WEEKDAY,
      }),
    ).toBe(11 * 60);
  });

  it("pre-6AM browsing of TODAY's calendar date keeps the opening floor (old +24h shift bug)", () => {
    // 00:30 Sat ET, probing Saturday (weekend closeHour 26): Saturday's own
    // day-part starts at 11 AM — the whole day must stay probeable.
    expect(
      earliestProbeMin({
        startDate: "2026-07-25",
        nowDateEt: "2026-07-25",
        nowMinutesEt: 30,
        leadMinutes: 15,
        ...WEEKEND,
      }),
    ).toBe(11 * 60);
  });

  it("post-midnight tail of YESTERDAY's weekend date → only 24-26h slots survive", () => {
    // 00:30 Sat ET, probing Friday (closes 2 AM): floor = 24:45.
    expect(
      earliestProbeMin({
        startDate: "2026-07-24",
        nowDateEt: "2026-07-25",
        nowMinutesEt: 30,
        leadMinutes: 15,
        ...WEEKEND,
      }),
    ).toBe(24 * 60 + 45);
  });

  it("yesterday's WEEKDAY date (closes midnight) is fully past even pre-6AM", () => {
    const { closeHour } = WEEKDAY;
    expect(
      earliestProbeMin({
        startDate: "2026-07-20",
        nowDateEt: "2026-07-21",
        nowMinutesEt: 30,
        leadMinutes: 15,
        ...WEEKDAY,
      }),
    ).toBe(closeHour * 60 + 1);
  });

  it("clearly past dates return the past-close sentinel", () => {
    expect(
      earliestProbeMin({
        startDate: "2026-07-10",
        nowDateEt: "2026-07-19",
        nowMinutesEt: 737,
        leadMinutes: 15,
        ...WEEKDAY,
      }),
    ).toBe(24 * 60 + 1);
  });

  it("late-night now (11:50 PM) on a weekend today floors into the 24-26h range", () => {
    expect(
      earliestProbeMin({
        startDate: "2026-07-24",
        nowDateEt: "2026-07-24",
        nowMinutesEt: 23 * 60 + 50,
        leadMinutes: 15,
        ...WEEKEND,
      }),
    ).toBe(24 * 60 + 15); // 23:50+15 = 24:05 → snap 24:15
  });
});
