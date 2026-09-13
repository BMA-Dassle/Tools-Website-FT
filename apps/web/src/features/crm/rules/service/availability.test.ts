import { describe, expect, it } from "vitest";
import {
  PROTOTYPE_NOW,
  PROTOTYPE_NOW_AFTERNOON,
  REP_ID,
  REPS,
  SHIFTS_TODAY,
  SHIFTS_TOMORROW,
} from "../test-support";
import {
  fmtHour,
  fmtWindow,
  nextStart,
  onShiftNow,
  rosterForDate,
  rosterFromShiftRows,
  rosterReps,
  rosterStatus,
  type ShiftRow,
} from "./availability";

/** ET shift arithmetic with an injected clock; `crm_shifts` rows → roster maps. */

const clockAt = (now: Date) => ({
  shiftsToday: SHIFTS_TODAY,
  shiftsTomorrow: SHIFTS_TOMORROW,
  now,
});

describe("fmtHour (crm-shared.js:171)", () => {
  it("formats whole and half hours in 12-hour time", () => {
    expect(fmtHour(9)).toBe("9 AM");
    expect(fmtHour(12)).toBe("12 PM");
    expect(fmtHour(12.5)).toBe("12:30 PM");
    expect(fmtHour(18)).toBe("6 PM");
    expect(fmtHour(0)).toBe("12 AM");
    expect(fmtHour(19.5)).toBe("7:30 PM");
    expect(fmtHour(25)).toBe("1 AM");
    expect(fmtHour(9.25)).toBe("9:15 AM");
    expect(fmtWindow({ startHour: 10, endHour: 18 })).toBe("10 AM – 6 PM");
    expect(fmtWindow(null)).toBeNull();
  });
});

describe("onShiftNow / nextStart at the two clocks", () => {
  it("19:30 ET: nobody but Guest Services and Stephanie is on; Kelsea's next is 9 AM tomorrow", () => {
    const c = clockAt(PROTOTYPE_NOW);
    expect(onShiftNow(REP_ID.kelsea, c)).toBe(false);
    expect(onShiftNow(REP_ID.stephanie, c)).toBe(true);
    expect(onShiftNow(REP_ID.gs, c)).toBe(true);
    expect(onShiftNow(REP_ID.lori, c)).toBe(false);
    expect(nextStart(REP_ID.kelsea, c)).toEqual({ when: "tomorrow", hour: 9 });
    expect(nextStart(REP_ID.lori, c)).toEqual({ when: "tomorrow", hour: 12 });
    expect(nextStart(REP_ID.stephanie, c)).toBeNull(); // on now, nothing tomorrow
    expect(nextStart(REP_ID.mkt, c)).toEqual({ when: "tomorrow", hour: 9 });
  });

  it("14:00 ET: Kelsea and Stephanie are on; Lori is off regardless of a window", () => {
    const c = clockAt(PROTOTYPE_NOW_AFTERNOON);
    expect(onShiftNow(REP_ID.kelsea, c)).toBe(true);
    expect(onShiftNow(REP_ID.stephanie, c)).toBe(true);
    const lori = {
      ...c,
      shiftsToday: {
        ...SHIFTS_TODAY,
        [REP_ID.lori]: { window: { startHour: 9, endHour: 17 }, off: true, offReason: "PTO" },
      },
    };
    expect(onShiftNow(REP_ID.lori, lori)).toBe(false);
    // Off today also hides today's later start; tomorrow still counts.
    expect(nextStart(REP_ID.lori, { ...lori, now: new Date("2026-09-12T08:00:00-04:00") })).toEqual(
      {
        when: "tomorrow",
        hour: 12,
      },
    );
  });

  it("08:00 ET: today's start is still ahead, so `today` wins over tomorrow", () => {
    const c = clockAt(new Date("2026-09-12T08:00:00-04:00"));
    expect(nextStart(REP_ID.kelsea, c)).toEqual({ when: "today", hour: 10 });
    expect(onShiftNow(REP_ID.kelsea, c)).toBe(false);
  });

  it("the hour is ET, not UTC: 23:30Z on Sep 12 is 7:30 PM ET", () => {
    const c = clockAt(new Date("2026-09-12T23:30:00Z"));
    expect(onShiftNow(REP_ID.kelsea, c)).toBe(false);
    expect(onShiftNow(REP_ID.stephanie, c)).toBe(true);
  });

  it("a rep with nothing on file is never on shift and has no next start", () => {
    const c = clockAt(PROTOTYPE_NOW);
    expect(onShiftNow("999", c)).toBe(false);
    expect(nextStart("999", c)).toBeNull();
  });
});

describe("rosterStatus (the 'Status now' cell)", () => {
  it("off · reason / On shift / Next … / Not scheduled", () => {
    const c = clockAt(PROTOTYPE_NOW);
    expect(rosterStatus(REP_ID.lori, c)).toEqual({ kind: "off", label: "Off · PTO" });
    expect(rosterStatus(REP_ID.stephanie, c)).toEqual({ kind: "on", label: "On shift" });
    expect(rosterStatus(REP_ID.kelsea, c)).toEqual({ kind: "next", label: "Next 9 AM tomorrow" });
    const nobody = { ...c, shiftsTomorrow: {} };
    expect(rosterStatus(REP_ID.kelsea, nobody)).toEqual({ kind: "none", label: "Not scheduled" });
    const manual = {
      ...c,
      shiftsToday: { [REP_ID.kelsea]: { window: null, off: true, offReason: null } },
    };
    expect(rosterStatus(REP_ID.kelsea, manual)).toEqual({ kind: "off", label: "Off · manual" });
  });
});

describe("rosterFromShiftRows — crm_shifts rows → ET windows", () => {
  const row = (over: Partial<ShiftRow>): ShiftRow => ({
    id: "1",
    repId: REP_ID.kelsea,
    shiftDate: "2026-09-12",
    startsAt: null,
    endsAt: null,
    source: "7shifts",
    sevenShiftsShiftId: "8801234501",
    locationId: 332160,
    offToday: false,
    offReason: null,
    updatedBy: null,
    syncedAt: "2026-09-12T12:00:00Z",
    ...over,
  });

  it("a 7shifts row with a local offset becomes a 10–18 window; timestamptz text is fine too", () => {
    const rows = [
      row({ startsAt: "2026-09-12T10:00:00-04:00", endsAt: "2026-09-12T18:00:00-04:00" }),
      row({
        id: "2",
        repId: REP_ID.stephanie,
        startsAt: "2026-09-12 16:00:00+00",
        endsAt: "2026-09-13 00:00:00+00",
      }),
    ];
    const r = rosterFromShiftRows(rows, { todayYmd: "2026-09-12", tomorrowYmd: "2026-09-13" });
    expect(r.shiftsToday[REP_ID.kelsea]).toEqual({
      window: { startHour: 10, endHour: 18 },
      off: false,
      offReason: null,
    });
    expect(r.shiftsToday[REP_ID.stephanie]?.window).toEqual({ startHour: 12, endHour: 20 });
    expect(r.shiftsTomorrow).toEqual({});
  });

  it("two shifts on one day merge into one window; a shift past midnight ends at hour + 24", () => {
    const rows = [
      row({ startsAt: "2026-09-12T09:00:00-04:00", endsAt: "2026-09-12T13:00:00-04:00" }),
      row({
        id: "2",
        sevenShiftsShiftId: "x2",
        startsAt: "2026-09-12T17:00:00-04:00",
        endsAt: "2026-09-13T01:00:00-04:00",
      }),
    ];
    expect(rosterForDate(rows, "2026-09-12")[REP_ID.kelsea]?.window).toEqual({
      startHour: 9,
      endHour: 25,
    });
  });

  it("a manual off row marks the day off without touching the 7shifts window; manual on-row does nothing", () => {
    const rows = [
      row({ startsAt: "2026-09-12T10:00:00-04:00", endsAt: "2026-09-12T18:00:00-04:00" }),
      row({
        id: "3",
        source: "manual",
        sevenShiftsShiftId: null,
        offToday: true,
        offReason: "PTO",
        updatedBy: "eric@headpinz.com",
      }),
      row({
        id: "4",
        repId: REP_ID.lori,
        source: "manual",
        sevenShiftsShiftId: null,
        offToday: false,
      }),
    ];
    const today = rosterForDate(rows, "2026-09-12");
    expect(today[REP_ID.kelsea]).toEqual({
      window: { startHour: 10, endHour: 18 },
      off: true,
      offReason: "PTO",
    });
    expect(today[REP_ID.lori]).toEqual({ window: null, off: false, offReason: null });
  });

  it("rows for other dates are ignored", () => {
    const rows = [
      row({
        shiftDate: "2026-09-11",
        startsAt: "2026-09-11T10:00:00-04:00",
        endsAt: "2026-09-11T18:00:00-04:00",
      }),
    ];
    expect(rosterForDate(rows, "2026-09-12")).toEqual({});
  });
});

describe("rosterReps", () => {
  it("lists everyone but the directors, active only", () => {
    expect(rosterReps(REPS).map((r) => r.slug)).toEqual([
      "kelsea",
      "lori",
      "stephanie",
      "gs",
      "mkt",
    ]);
    expect(
      rosterReps(REPS.map((r) => (r.slug === "mkt" ? { ...r, active: false } : r))).map(
        (r) => r.slug,
      ),
    ).toEqual(["kelsea", "lori", "stephanie", "gs"]);
  });
});
