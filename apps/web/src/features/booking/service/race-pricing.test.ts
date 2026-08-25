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

  /**
   * Mega Thursdays, 2026-09-03 → end of October (owner 2026-08-25). The
   * schedule is what decides which BMI products are SELLABLE, so this is the
   * assertion that a Mega Thursday sells Mega races and stops selling the
   * Blue/Red weekday ones.
   *
   * The plain-Thursday cases above (June) are deliberately left untouched: a
   * Thursday outside the season must still resolve "weekday", and their
   * passing unchanged is the proof this shipped no accidental change.
   */
  describe("the Sep–Oct 2026 Mega Thursday season", () => {
    it("a Thursday inside the season → mega, not weekday", () => {
      expect(scheduleForDate("2026-09-03")).toBe("mega"); // first
      expect(scheduleForDate("2026-10-08")).toBe("mega"); // mid
      expect(scheduleForDate("2026-10-29")).toBe("mega"); // last
    });

    it("a Thursday outside the season is still an ordinary weekday", () => {
      expect(scheduleForDate("2026-08-27")).toBe("weekday"); // before it opens
      expect(scheduleForDate("2026-11-05")).toBe("weekday"); // after it closes
    });

    it("leaves the rest of the season's week alone", () => {
      expect(scheduleForDate("2026-09-08")).toBe("mega"); // Tuesday, as always
      expect(scheduleForDate("2026-09-02")).toBe("weekday"); // Wednesday
      expect(scheduleForDate("2026-09-04")).toBe("weekend"); // Friday
      expect(scheduleForDate("2026-10-31")).toBe("weekend"); // Sat — window ends, still weekend
    });
  });
});

describe("upsell price constants", () => {
  it("exposes LICENSE_PRICE for first-time-racer line items", () => {
    expect(LICENSE_PRICE).toBe(4.99);
  });

  it("exposes POV_PRICE + POV_CHECKIN_PRICE (deferred feature — kept for forward-compat)", () => {
    expect(POV_PRICE).toBe(4.99); // owner 2026-08-04: POV moved $5.00 → $4.99
    expect(POV_CHECKIN_PRICE).toBe(7);
  });
});
