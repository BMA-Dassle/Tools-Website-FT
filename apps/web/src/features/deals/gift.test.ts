/**
 * Gift scheduling — the date rules.
 *
 * Every assertion here is about a boundary that costs real money or real
 * embarrassment if it slips: a present that arrives in August instead of
 * December, or a voucher that lands already expired.
 */

import { describe, expect, it } from "vitest";
import {
  checkGiftDate,
  etToday,
  formatGiftDate,
  giftDateWindow,
  giftSendAtUtc,
  GIFT_MAX_MONTHS_AHEAD,
} from "./gift";

/** Noon UTC on a summer day — EDT, offset -04:00. */
const SUMMER = new Date("2026-08-03T16:00:00Z");
/** Noon UTC on a winter day — EST, offset -05:00. */
const WINTER = new Date("2026-12-15T16:00:00Z");

describe("giftSendAtUtc", () => {
  it("resolves 8 AM Eastern across the DST boundary", () => {
    // EDT: 8 AM ET === 12:00 UTC. EST: 8 AM ET === 13:00 UTC. Hardcoding one
    // offset year-round is the exact bug lib/et-time.ts exists to prevent.
    expect(giftSendAtUtc("2026-08-20")).toBe("2026-08-20T12:00:00.000Z");
    expect(giftSendAtUtc("2026-12-25")).toBe("2026-12-25T13:00:00.000Z");
  });

  it("never lands on the day before in Eastern", () => {
    // Midnight UTC would render as the 24th in ET. 8 AM never can.
    for (const date of ["2026-01-01", "2026-03-08", "2026-11-01", "2026-12-25"]) {
      expect(formatGiftDate(date)).toContain(String(Number(date.slice(8, 10))));
    }
  });
});

describe("etToday", () => {
  it("reads the Eastern calendar date, not UTC's", () => {
    // 01:30 UTC on the 4th is still 21:30 ET on the 3rd.
    expect(etToday(new Date("2026-08-04T01:30:00Z"))).toBe("2026-08-03");
    expect(etToday(SUMMER)).toBe("2026-08-03");
  });
});

describe("giftDateWindow", () => {
  it("opens today and closes at the policy ceiling for a long-lived voucher", () => {
    const w = giftDateWindow({ expiresMonths: 12, now: SUMMER });
    expect(w.min).toBe("2026-08-03");
    // 6 months out, well before the 12-month expiry minus 30 days.
    expect(w.max).toBe("2027-02-03");
  });

  it("closes EARLY when the voucher expires before the policy ceiling", () => {
    // A 3-month voucher must leave 30 days of life, so the ceiling is ~2 months.
    const w = giftDateWindow({ expiresMonths: 3, now: SUMMER });
    expect(w.max).toBe("2026-10-04");
    expect(w.max < "2027-02-03").toBe(true);
  });

  it("clamps a month-end date instead of rolling into the next month", () => {
    // Aug 31 + 6 months is "Feb 31" — must land on Feb 28, not Mar 3.
    const w = giftDateWindow({ expiresMonths: 24, now: new Date("2026-08-31T16:00:00Z") });
    expect(w.max).toBe("2027-02-28");
  });
});

describe("checkGiftDate", () => {
  const opts = { expiresMonths: 12, now: SUMMER };

  it("treats no date as send-now", () => {
    expect(checkGiftDate(undefined, opts)).toEqual({ ok: true, sendAt: null });
    expect(checkGiftDate(null, opts)).toEqual({ ok: true, sendAt: null });
  });

  it("treats TODAY as send-now, not as a schedule", () => {
    // A same-day timestamp would park the row in `scheduled` and leave a paid
    // gift looking undelivered until the next cron pass.
    expect(checkGiftDate("2026-08-03", opts)).toEqual({ ok: true, sendAt: null });
  });

  it("schedules a future date at 8 AM Eastern", () => {
    const res = checkGiftDate("2026-12-25", opts);
    expect(res).toEqual({ ok: true, sendAt: "2026-12-25T13:00:00.000Z" });
  });

  it("refuses a date in the past", () => {
    const res = checkGiftDate("2026-08-02", opts);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message).toMatch(/already passed/i);
  });

  it("refuses a date past the window, and says what the limit is", () => {
    const res = checkGiftDate("2027-06-01", opts);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.message).toMatch(/February 3, 2027/);
      expect(res.message).toMatch(/expires/i);
    }
  });

  it("refuses a delivery that would leave the recipient under a month", () => {
    // 3-month voucher, delivery 2.5 months out — inside the 6-month policy
    // ceiling but past the expiry guard.
    const res = checkGiftDate("2026-10-20", { expiresMonths: 3, now: SUMMER });
    expect(res.ok).toBe(false);
  });

  it("rejects a malformed date rather than coercing it", () => {
    for (const bad of ["12/25/2026", "2026-13-01x", "tomorrow", ""]) {
      const res = checkGiftDate(bad, opts);
      // "" is falsy and means send-now; everything else must be refused.
      if (bad === "") expect(res).toEqual({ ok: true, sendAt: null });
      else expect(res.ok).toBe(false);
    }
  });

  it("works in winter too — the ceiling is still 6 months, inclusive", () => {
    const winter = { expiresMonths: 12, now: WINTER };
    expect(giftDateWindow(winter).max).toBe("2027-06-15");
    // The boundary day itself is allowed; the day after is not.
    expect(checkGiftDate("2027-06-15", winter).ok).toBe(true);
    expect(checkGiftDate("2027-06-16", winter).ok).toBe(false);
    expect(GIFT_MAX_MONTHS_AHEAD).toBe(6);
  });
});

describe("formatGiftDate", () => {
  it("shows the date the buyer picked, not the UTC-shifted one", () => {
    expect(formatGiftDate("2026-12-25")).toBe("December 25, 2026");
    expect(formatGiftDate("2026-12-25T13:00:00.000Z")).toBe("December 25, 2026");
  });
});
