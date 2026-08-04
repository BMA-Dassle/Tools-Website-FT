import { describe, it, expect } from "vitest";
import {
  fasttraxDuckpinHours,
  FASTTRAX_DUCKPIN_LEAD_MINUTES,
  FASTTRAX_QAMF_CENTER_ID,
  isFastTraxDuckpinCenter,
} from "./qamf-centers";
import { centerHoursForDate } from "~/features/booking/service/bowling-hours";

// FastTrax duckpin (11542) sits inside the HeadPinz Fort Myers building, so for
// a long time it silently inherited the FM bowling floor's hours — midnight
// Sun-Thu, 2 AM Fri-Sat. It actually closes at 11 PM / midnight (owner-confirmed
// 2026-07-23), so the grid was offering slots for 1-2 hours after it had shut.
// These tests pin the boundary so the two can never drift back together.

const FM_QAMF_CENTER_ID = 9172;

describe("fasttraxDuckpinHours", () => {
  it("opens at 11 AM every day", () => {
    for (const d of ["2026-08-04", "2026-08-07", "2026-08-08", "2026-08-09"]) {
      expect(fasttraxDuckpinHours(d).open).toBe(11);
    }
  });

  it("closes at 11 PM Sun-Thu", () => {
    expect(fasttraxDuckpinHours("2026-08-09").close).toBe(23); // Sunday
    expect(fasttraxDuckpinHours("2026-08-10").close).toBe(23); // Monday
    expect(fasttraxDuckpinHours("2026-08-04").close).toBe(23); // Tuesday
  });

  it("closes at midnight Fri-Sat", () => {
    expect(fasttraxDuckpinHours("2026-08-07").close).toBe(24); // Friday
    expect(fasttraxDuckpinHours("2026-08-08").close).toBe(24); // Saturday
  });
});

describe("centerHoursForDate routes the duckpin away from Fort Myers", () => {
  it("gives 11542 its own hours, not the FM floor's", () => {
    // Tuesday: FM runs to midnight (24), duckpin stops at 11 PM (23).
    expect(centerHoursForDate(FASTTRAX_QAMF_CENTER_ID, "2026-08-04").close).toBe(23);
    expect(centerHoursForDate(FM_QAMF_CENTER_ID, "2026-08-04").close).toBe(24);
  });

  it("keeps the gap on Fri-Sat, where FM runs to 2 AM", () => {
    // This is the wider of the two gaps — two whole hours of phantom slots.
    expect(centerHoursForDate(FASTTRAX_QAMF_CENTER_ID, "2026-08-07").close).toBe(24);
    expect(centerHoursForDate(FM_QAMF_CENTER_ID, "2026-08-07").close).toBe(26);
  });

  it("leaves the other centers alone", () => {
    const naples = centerHoursForDate(3148, "2026-08-04");
    expect(naples).toEqual({ open: 11, close: 24 });
  });
});

describe("booking lead", () => {
  it("is 5 minutes for the duckpin — walk-up friendly, vs 15 for HeadPinz", () => {
    expect(FASTTRAX_DUCKPIN_LEAD_MINUTES).toBe(5);
  });

  it("identifies the duckpin center and nothing else", () => {
    expect(isFastTraxDuckpinCenter(FASTTRAX_QAMF_CENTER_ID)).toBe(true);
    expect(isFastTraxDuckpinCenter(FM_QAMF_CENTER_ID)).toBe(false);
    expect(isFastTraxDuckpinCenter(null)).toBe(false);
    expect(isFastTraxDuckpinCenter(undefined)).toBe(false);
  });
});
