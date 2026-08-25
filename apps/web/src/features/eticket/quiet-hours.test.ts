import { afterEach, describe, expect, it } from "vitest";
import {
  ETICKET_CRON_SOURCES,
  ETICKET_EXPIRED_ERROR,
  heldUntilMorning,
  hourET,
  inEticketQuietHours,
  isEticketSource,
  maxQueueAgeMs,
  quietEndHourET,
  quietStartHourET,
} from "./quiet-hours";
import { NET_FAR_MS } from "~/features/racing/roster-dirty";

/** Build a Date at a given EASTERN wall-clock hour. 2026-08-16 is EDT
 *  (UTC-4); 2026-01-15 is EST (UTC-5) — both covered so a DST bug can't
 *  hide. */
function edt(hour: number, minute = 0): Date {
  return new Date(Date.UTC(2026, 7, 16, hour + 4, minute));
}
function est(hour: number, minute = 0): Date {
  return new Date(Date.UTC(2026, 0, 15, hour + 5, minute));
}

afterEach(() => {
  delete process.env.ETICKET_QUIET_START_ET;
  delete process.env.ETICKET_QUIET_END_ET;
});

describe("inEticketQuietHours", () => {
  it("defaults to quiet 2am–9am ET, open otherwise (HPFM/HPN run past midnight)", () => {
    expect(inEticketQuietHours(edt(0, 30))).toBe(false); // 12:30am — late-close nights still send
    expect(inEticketQuietHours(edt(1, 59))).toBe(false); // 1:59am — last pre-quiet minute
    expect(inEticketQuietHours(edt(2, 0))).toBe(true); // 2:00am — quiet begins
    expect(inEticketQuietHours(edt(3, 0))).toBe(true); // 3am — the canonical bad send
    expect(inEticketQuietHours(edt(8, 59))).toBe(true); // 8:59am — the floor moved 8 → 9
    expect(inEticketQuietHours(edt(9, 0))).toBe(false); // 9:00am — the day's tickets flow
    expect(inEticketQuietHours(edt(12, 0))).toBe(false);
    expect(inEticketQuietHours(edt(23, 59))).toBe(false); // late close: check-in alerts still fire
  });

  it("holds across DST (EST winter dates)", () => {
    expect(inEticketQuietHours(est(1, 30))).toBe(false);
    expect(inEticketQuietHours(est(3, 0))).toBe(true);
    expect(inEticketQuietHours(est(9, 0))).toBe(false);
    expect(inEticketQuietHours(est(22, 0))).toBe(false);
  });

  it("owner's alternate 4am start is a pure env change", () => {
    process.env.ETICKET_QUIET_START_ET = "4";
    expect(inEticketQuietHours(edt(3, 30))).toBe(false); // still sending at 3:30am
    expect(inEticketQuietHours(edt(4, 0))).toBe(true);
    expect(inEticketQuietHours(edt(9, 0))).toBe(false);
  });

  it("supports a midnight-wrapping window via env", () => {
    process.env.ETICKET_QUIET_START_ET = "23";
    process.env.ETICKET_QUIET_END_ET = "8";
    expect(inEticketQuietHours(edt(23, 30))).toBe(true);
    expect(inEticketQuietHours(edt(2, 0))).toBe(true);
    expect(inEticketQuietHours(edt(8, 30))).toBe(false);
    expect(inEticketQuietHours(edt(22, 30))).toBe(false);
  });

  it("start === end disables the gate; junk env falls back to defaults", () => {
    process.env.ETICKET_QUIET_START_ET = "8";
    process.env.ETICKET_QUIET_END_ET = "8";
    expect(inEticketQuietHours(edt(3, 0))).toBe(false);

    process.env.ETICKET_QUIET_START_ET = "not-a-number";
    process.env.ETICKET_QUIET_END_ET = "99";
    expect(inEticketQuietHours(edt(3, 0))).toBe(true); // defaults 2–9 apply
    expect(inEticketQuietHours(edt(1, 0))).toBe(false);
    expect(inEticketQuietHours(edt(9, 0))).toBe(false);
  });
});

describe("hourET", () => {
  it("reports midnight as 0, never 24", () => {
    // h24-cycle ICU builds format midnight as "24", which would read as
    // "later than every floor" and invert the late-night carve-out.
    expect(hourET(edt(0, 0))).toBe(0);
    expect(hourET(est(0, 0))).toBe(0);
  });
});

describe("heldUntilMorning", () => {
  /** ISO 8601 UTC, the shape Pandora returns scheduledStart in. */
  const session = (etHour: number, etMinute = 0) => edt(etHour, etMinute).toISOString();

  it("holds a daytime session announced in the small hours", () => {
    // The real 2026-08-25 send: a racer texted at 12:01am about a heat
    // checking in at 4:50pm.
    expect(heldUntilMorning(session(16, 50), edt(0, 1))).toBe(true);
  });

  it("holds right up to the floor, and releases on it", () => {
    expect(heldUntilMorning(session(11, 0), edt(8, 59))).toBe(true);
    expect(heldUntilMorning(session(11, 0), edt(9, 0))).toBe(false);
  });

  it("NEVER holds a late-night session announced after midnight", () => {
    // The 57 real sends this must not break: HP Arena laser tag at 12:45am,
    // ticketed at 12:00am to a guest already in the building.
    expect(heldUntilMorning(session(0, 45), edt(0, 0))).toBe(false);
    expect(heldUntilMorning(session(1, 15), edt(0, 30))).toBe(false);
  });

  it("never delays a ticket past its own session", () => {
    // An 8:30am session seen at 6:30am. Holding to 9 would land the ticket
    // after the session ran.
    expect(heldUntilMorning(session(8, 30), edt(6, 30))).toBe(false);
  });

  it("does nothing once the day is open", () => {
    expect(heldUntilMorning(session(16, 50), edt(14, 0))).toBe(false);
    expect(heldUntilMorning(session(23, 30), edt(23, 0))).toBe(false);
  });

  it("holds on the EST offset too — the floor is ET, not UTC", () => {
    expect(heldUntilMorning(est(11, 0).toISOString(), est(1, 0))).toBe(true);
    expect(heldUntilMorning(est(11, 0).toISOString(), est(9, 0))).toBe(false);
  });

  it("moves with the env floor", () => {
    process.env.ETICKET_QUIET_END_ET = "11";
    expect(heldUntilMorning(session(11, 30), edt(9, 0))).toBe(true);
    expect(heldUntilMorning(session(11, 30), edt(11, 0))).toBe(false);
    expect(heldUntilMorning(session(10, 30), edt(9, 0))).toBe(false); // starts before the floor
  });

  it("is disabled with the gate when start === end", () => {
    process.env.ETICKET_QUIET_START_ET = "9";
    process.env.ETICKET_QUIET_END_ET = "9";
    expect(heldUntilMorning(session(16, 50), edt(0, 1))).toBe(false);
  });

  it("fails OPEN on a missing or unparseable start", () => {
    expect(heldUntilMorning(null, edt(0, 1))).toBe(false);
    expect(heldUntilMorning("", edt(0, 1))).toBe(false);
    expect(heldUntilMorning("not a date", edt(0, 1))).toBe(false);
  });

  it("accepts a Date as well as an ISO string", () => {
    expect(heldUntilMorning(edt(16, 50), edt(0, 1))).toBe(true);
  });

  /**
   * The held racers only come back because the pre-race cron re-reads their
   * roster on the first tick after the floor, and it only does that because
   * the quiet window is longer than the roster planner's far net. Pin the
   * invariant: if someone shortens the window, the tickets silently wait for
   * the 2h near horizon instead of going out at the floor.
   */
  it("keeps the quiet window longer than the roster far net", () => {
    const gapMs = (quietEndHourET() - quietStartHourET()) * 60 * 60 * 1000;
    expect(gapMs).toBeGreaterThan(NET_FAR_MS);

    process.env.ETICKET_QUIET_START_ET = "4"; // the documented ops alternative
    expect((quietEndHourET() - quietStartHourET()) * 60 * 60 * 1000).toBeGreaterThan(NET_FAR_MS);
  });
});

describe("e-ticket source scoping", () => {
  it("covers exactly the four e-ticket cron tags", () => {
    for (const s of ETICKET_CRON_SOURCES) expect(isEticketSource(s)).toBe(true);
    // The quiet-hours guarantee must NOT swallow other guest messaging.
    expect(isEticketSource("booking-confirm")).toBe(false);
    expect(isEticketSource("video-match")).toBe(false);
    expect(isEticketSource("bowling-lane-ready")).toBe(false);
    expect(isEticketSource("admin-resend")).toBe(false);
  });

  it("ages out check-in alerts far faster than pre-session tickets", () => {
    expect(maxQueueAgeMs("checkin-cron")).toBe(30 * 60 * 1000);
    expect(maxQueueAgeMs("arena-checkin-cron")).toBe(30 * 60 * 1000);
    expect(maxQueueAgeMs("pre-race-cron")).toBe(3 * 60 * 60 * 1000);
    expect(maxQueueAgeMs("arena-pre-cron")).toBe(3 * 60 * 60 * 1000);
  });

  it("pins the audit error string the admin board keys on", () => {
    expect(ETICKET_EXPIRED_ERROR.startsWith("expired in queue")).toBe(true);
  });
});
