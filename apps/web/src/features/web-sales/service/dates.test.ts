import { describe, expect, it } from "vitest";
import { daysBetweenYmd, defaultRange, easternRangeToUtc, shiftYmd, todayEasternYmd } from "./dates";

// 2026 US DST: starts Sun 8 March, ends Sun 1 November.

describe("todayEasternYmd", () => {
  it("is still yesterday's date during the evening ET / next-day UTC window", () => {
    // 02:00Z on the 4th is 22:00 ET on the 3rd — peak sale time for a family
    // entertainment centre, and exactly when a UTC-derived 'today' is wrong.
    expect(todayEasternYmd(new Date("2026-08-04T02:00:00Z"))).toBe("2026-08-03");
  });

  it("has already rolled over in the small hours ET", () => {
    expect(todayEasternYmd(new Date("2026-08-03T05:00:00Z"))).toBe("2026-08-03");
  });

  it("is correct on either side of the standard-time boundary", () => {
    // 03:30Z on 2 Nov is 22:30 EST on 1 Nov.
    expect(todayEasternYmd(new Date("2026-11-02T03:30:00Z"))).toBe("2026-11-01");
  });
});

describe("shiftYmd", () => {
  it("moves whole days", () => {
    expect(shiftYmd("2026-08-03", 1)).toBe("2026-08-04");
    expect(shiftYmd("2026-08-03", -1)).toBe("2026-08-02");
    expect(shiftYmd("2026-08-03", 0)).toBe("2026-08-03");
  });

  it("crosses month, year and leap boundaries", () => {
    expect(shiftYmd("2026-07-31", 1)).toBe("2026-08-01");
    expect(shiftYmd("2026-01-01", -1)).toBe("2025-12-31");
    expect(shiftYmd("2028-02-28", 1)).toBe("2028-02-29");
  });

  it("does not stall or skip across a DST transition", () => {
    // The midday anchor exists for this: a midnight anchor can repeat or skip a
    // date on the two days a year the clocks move.
    expect(shiftYmd("2026-03-07", 1)).toBe("2026-03-08");
    expect(shiftYmd("2026-03-08", 1)).toBe("2026-03-09");
    expect(shiftYmd("2026-10-31", 1)).toBe("2026-11-01");
    expect(shiftYmd("2026-11-01", 1)).toBe("2026-11-02");
  });
});

describe("daysBetweenYmd", () => {
  it("counts inclusively", () => {
    expect(daysBetweenYmd("2026-08-03", "2026-08-03")).toBe(1);
    expect(daysBetweenYmd("2026-08-01", "2026-08-03")).toBe(3);
  });

  it("counts correctly across a DST transition", () => {
    expect(daysBetweenYmd("2026-10-31", "2026-11-02")).toBe(3);
  });
});

describe("defaultRange", () => {
  it("is the last 30 ET days, inclusive of today", () => {
    const range = defaultRange(new Date("2026-08-03T16:00:00Z"));
    expect(range).toEqual({ from: "2026-07-05", to: "2026-08-03" });
    expect(daysBetweenYmd(range.from, range.to)).toBe(30);
  });
});

describe("easternRangeToUtc", () => {
  it("covers a summer day from ET midnight to ET midnight", () => {
    expect(easternRangeToUtc("2026-08-01", "2026-08-03")).toEqual({
      startUtc: "2026-08-01T04:00:00.000Z",
      endUtc: "2026-08-04T04:00:00.000Z",
    });
  });

  it("uses standard time in winter, not a hardcoded offset", () => {
    expect(easternRangeToUtc("2026-01-01", "2026-01-01")).toEqual({
      startUtc: "2026-01-01T05:00:00.000Z",
      endUtc: "2026-01-02T05:00:00.000Z",
    });
  });

  it("picks the right offset at each end when the range straddles the DST change", () => {
    // Start is EDT, end is EST. A single hardcoded offset gets one of them wrong.
    expect(easternRangeToUtc("2026-10-31", "2026-11-01")).toEqual({
      startUtc: "2026-10-31T04:00:00.000Z",
      endUtc: "2026-11-02T05:00:00.000Z",
    });
  });

  it("is half-open, so a sale in the last second of the final day is included", () => {
    const { startUtc, endUtc } = easternRangeToUtc("2026-08-03", "2026-08-03");
    const lastSecond = new Date("2026-08-03T23:59:59.500-04:00").toISOString();
    expect(lastSecond >= startUtc).toBe(true);
    // A `<=` against an end-of-day 23:59:59 would drop this row.
    expect(lastSecond < endUtc).toBe(true);
  });
});
