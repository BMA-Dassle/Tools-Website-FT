import { afterEach, describe, expect, it } from "vitest";
import {
  ETICKET_CRON_SOURCES,
  ETICKET_EXPIRED_ERROR,
  inEticketQuietHours,
  isEticketSource,
  maxQueueAgeMs,
} from "./quiet-hours";

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
  it("defaults to quiet 2am–8am ET, open otherwise (HPFM/HPN run past midnight)", () => {
    expect(inEticketQuietHours(edt(0, 30))).toBe(false); // 12:30am — late-close nights still send
    expect(inEticketQuietHours(edt(1, 59))).toBe(false); // 1:59am — last pre-quiet minute
    expect(inEticketQuietHours(edt(2, 0))).toBe(true); // 2:00am — quiet begins
    expect(inEticketQuietHours(edt(3, 0))).toBe(true); // 3am — the canonical bad send
    expect(inEticketQuietHours(edt(7, 59))).toBe(true); // 7:59am
    expect(inEticketQuietHours(edt(8, 0))).toBe(false); // 8:00am — morning pre-sends flow
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
    expect(inEticketQuietHours(edt(8, 0))).toBe(false);
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
    expect(inEticketQuietHours(edt(3, 0))).toBe(true); // defaults 2–8 apply
    expect(inEticketQuietHours(edt(1, 0))).toBe(false);
    expect(inEticketQuietHours(edt(9, 0))).toBe(false);
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
