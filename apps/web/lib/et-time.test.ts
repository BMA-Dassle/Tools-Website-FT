import { describe, it, expect } from "vitest";
import { etOffsetForLocalDate, hasTimezone, normalizeEtDate } from "./et-time";

/**
 * These dates are the whole point of the helper. Two different month-based
 * approximations were live in the codebase until 2026-08-25 and BOTH produced
 * wrong offsets for real trading days:
 *
 *   `month >= 3 && month <= 11`  (bowling availability, kiosk availability,
 *      race-dayof-pay, race-live-state) — called ALL of November EDT. Every
 *      booking from Nov 2 (DST ends Nov 1) through Nov 30 was built an hour
 *      off. Also wrong for Mar 1-7.
 *
 *   `month >= 4 && month <= 10`  (pov-codes report/breakage, videos
 *      list/backfill) — called Mar 8-31 EST, shifting those daily windows.
 *
 * If either heuristic is ever reintroduced, these fail.
 */
describe("etOffsetForLocalDate — DST boundaries", () => {
  // 2026: DST starts Sun Mar 8, ends Sun Nov 1.
  it.each([
    ["2026-01-15", "-05:00", "midwinter EST"],
    ["2026-03-07", "-05:00", "day before DST starts — the 3..11 heuristic said EDT"],
    ["2026-03-08", "-04:00", "DST starts — the 4..10 heuristic said EST"],
    ["2026-03-31", "-04:00", "late March EDT — the 4..10 heuristic said EST"],
    ["2026-07-04", "-04:00", "midsummer EDT"],
    ["2026-10-31", "-04:00", "day before DST ends"],
    ["2026-11-01", "-05:00", "DST ends 2 AM — noon is already EST"],
    ["2026-11-02", "-05:00", "the NFL-season bug: 3..11 said EDT"],
    ["2026-11-30", "-05:00", "end of November still EST"],
    ["2026-12-19", "-05:00", "the original BMI 6pm->5pm contract bug date"],
  ])("%s → %s (%s)", (date, expected) => {
    expect(etOffsetForLocalDate(date)).toBe(expected);
  });

  it("accepts a full ISO string, not just a bare date", () => {
    expect(etOffsetForLocalDate("2026-11-02T20:05:00")).toBe("-05:00");
    expect(etOffsetForLocalDate("2026-09-20T15:50:00")).toBe("-04:00");
  });

  it("falls back to EST on unparseable input rather than throwing", () => {
    expect(etOffsetForLocalDate("")).toBe("-05:00");
    expect(etOffsetForLocalDate("not-a-date")).toBe("-05:00");
  });

  it("never returns a month-approximated answer for the disputed span", () => {
    // Every day of November 2026 is EST. The old bowling heuristic returned
    // EDT for all of them.
    for (let d = 2; d <= 30; d++) {
      const day = `2026-11-${String(d).padStart(2, "0")}`;
      expect(etOffsetForLocalDate(day)).toBe("-05:00");
    }
  });
});

describe("normalizeEtDate", () => {
  it("appends the correct offset to a tz-less wall clock", () => {
    expect(normalizeEtDate("2026-11-02T20:05:00")).toBe("2026-11-02T20:05:00-05:00");
    expect(normalizeEtDate("2026-09-20T20:05:00")).toBe("2026-09-20T20:05:00-04:00");
  });

  it("leaves an already-zoned string alone", () => {
    expect(normalizeEtDate("2026-11-02T20:05:00-05:00")).toBe("2026-11-02T20:05:00-05:00");
    expect(normalizeEtDate("2026-11-02T20:05:00Z")).toBe("2026-11-02T20:05:00Z");
  });

  it("passes empty input straight through", () => {
    expect(normalizeEtDate("")).toBe("");
  });
});

describe("hasTimezone", () => {
  it.each([
    ["2026-11-02T20:05:00Z", true],
    ["2026-11-02T20:05:00-05:00", true],
    ["2026-11-02T20:05:00+02:00", true],
    ["2026-11-02T20:05:00", false],
    ["2026-11-02", false],
  ])("%s → %s", (input, expected) => {
    expect(hasTimezone(input)).toBe(expected);
  });
});

/**
 * The bowling availability route builds QAMF probe instants as
 * `${date}T${hh}:${mm}:00${tzOffset}`. This pins the end-to-end consequence:
 * a Sunday-night NFL kickoff in November must resolve to the right instant.
 */
describe("regression: November NFL kickoff builds the right instant", () => {
  it("8:05 PM ET on 2026-11-08 is 01:05 UTC the next day", () => {
    const iso = `2026-11-08T20:05:00${etOffsetForLocalDate("2026-11-08")}`;
    expect(new Date(iso).toISOString()).toBe("2026-11-09T01:05:00.000Z");
  });

  it("the old heuristic would have been an hour early", () => {
    // month >= 3 && month <= 11 → "-04:00"
    expect(new Date("2026-11-08T20:05:00-04:00").toISOString()).toBe("2026-11-09T00:05:00.000Z");
  });
});
