import { describe, expect, it } from "vitest";
import {
  FL_TAX_RATE,
  LICENSE_PRICE,
  POV_CHECKIN_PRICE,
  POV_PRICE,
  calculateTax,
  calculateTotal,
  scheduleForDate,
} from "./race-pricing";

describe("FL sales tax", () => {
  it("FL_TAX_RATE is 6.5%", () => {
    expect(FL_TAX_RATE).toBe(0.065);
  });

  it("calculateTax rounds to the cent", () => {
    expect(calculateTax(20)).toBeCloseTo(1.3, 2); // 20 * 0.065 = 1.30
    expect(calculateTax(20.99)).toBeCloseTo(1.36, 2); // 20.99 * 0.065 = 1.36435 → 1.36
    expect(calculateTax(0)).toBe(0);
  });

  it("calculateTotal sums subtotal + tax", () => {
    expect(calculateTotal(20)).toBeCloseTo(21.3, 2);
    expect(calculateTotal(20.99)).toBeCloseTo(22.35, 2);
  });
});

describe("scheduleForDate", () => {
  it("Tuesday → mega", () => {
    expect(scheduleForDate("2026-06-02")).toBe("mega"); // 2026-06-02 is Tuesday
  });

  it("Friday, Saturday, Sunday → weekend", () => {
    expect(scheduleForDate("2026-06-05")).toBe("weekend"); // Friday
    expect(scheduleForDate("2026-06-06")).toBe("weekend"); // Saturday
    expect(scheduleForDate("2026-06-07")).toBe("weekend"); // Sunday
  });

  it("Monday, Wednesday, Thursday → weekday", () => {
    expect(scheduleForDate("2026-06-01")).toBe("weekday"); // Monday
    expect(scheduleForDate("2026-06-03")).toBe("weekday"); // Wednesday
    expect(scheduleForDate("2026-06-04")).toBe("weekday"); // Thursday
  });

  it("accepts ISO strings with T-times", () => {
    expect(scheduleForDate("2026-06-02T15:00:00.000Z")).toBe("mega");
  });

  it("accepts Date objects", () => {
    // Build a Tuesday in local time
    expect(scheduleForDate(new Date(2026, 5, 2))).toBe("mega");
  });

  it("uses local-time parsing for YYYY-MM-DD strings (avoids UTC trap)", () => {
    // 2026-06-02 in US-Eastern is still Tuesday even if parsed at midnight UTC
    expect(scheduleForDate("2026-06-02")).toBe("mega");
  });
});

describe("upsell price constants", () => {
  it("exposes LICENSE_PRICE for first-time-racer line items", () => {
    expect(LICENSE_PRICE).toBe(4.99);
  });

  it("exposes POV_PRICE + POV_CHECKIN_PRICE (deferred feature — kept for forward-compat)", () => {
    expect(POV_PRICE).toBe(5);
    expect(POV_CHECKIN_PRICE).toBe(7);
  });
});
