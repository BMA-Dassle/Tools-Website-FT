import { describe, expect, it } from "vitest";
import {
  applyPromoToAmount,
  applyPromoToBillLines,
  isPromoEligibleLine,
  promoFactor,
  promoSavingsCents,
  type PromoableLine,
} from "./promo-pricing";
import type { AppliedPromo } from "~/features/discount-codes";

// USA250 — 25% off racing/bowling/attractions, visit date July 4 2026 only.
const USA250: AppliedPromo = {
  code: "USA250",
  domains: ["racing", "bowling", "attractions"],
  scopes: {
    racing: { productSlugs: null },
    bowling: { experienceSlugs: null },
    attractions: { slugs: null },
  },
  startsAt: "2026-06-01T00:00:00Z",
  expiresAt: "2026-07-05T04:00:00Z", // end of July 4, ET
  allowedWeekdays: null,
  bookingDateStart: "2026-07-04",
  bookingDateEnd: "2026-07-04",
  mechanic: "percent",
  amountPct: 25,
  amountCents: null,
  squareCatalogId: null,
};

// A purchase made during the sale window (before/through July 4).
const NOW = new Date("2026-06-26T12:00:00Z");

describe("promoFactor", () => {
  it("is 0.75 for an eligible July-4 racing line", () => {
    expect(promoFactor({ domain: "racing", visitDate: "2026-07-04" }, USA250, { now: NOW })).toBe(
      0.75,
    );
  });

  it("is 1 for a July-5 line (outside the booking-date window)", () => {
    expect(promoFactor({ domain: "racing", visitDate: "2026-07-05" }, USA250, { now: NOW })).toBe(
      1,
    );
  });

  it("is 1 when there is no promo", () => {
    expect(promoFactor({ domain: "racing", visitDate: "2026-07-04" }, null, { now: NOW })).toBe(1);
  });
});

describe("applyPromoToAmount", () => {
  it("takes 25% off an eligible line and reports the savings", () => {
    const r = applyPromoToAmount(20.99, { domain: "racing", visitDate: "2026-07-04" }, USA250, {
      now: NOW,
    });
    expect(r.applied).toBe(true);
    expect(r.originalAmount).toBe(20.99);
    expect(r.amount).toBeCloseTo(15.74, 2); // 20.99 * 0.75 = 15.7425 → 15.74
    expect(r.amountOffCents).toBe(525); // 20.99 - 15.74 = 5.25
  });

  it("leaves a July-5 line untouched", () => {
    const r = applyPromoToAmount(20.99, { domain: "racing", visitDate: "2026-07-05" }, USA250, {
      now: NOW,
    });
    expect(r.applied).toBe(false);
    expect(r.amount).toBe(20.99);
    expect(r.amountOffCents).toBe(0);
  });
});

describe("isPromoEligibleLine", () => {
  it("true for an in-scope July-4 line, false on July 5 and for null promo", () => {
    expect(
      isPromoEligibleLine({ domain: "bowling", visitDate: "2026-07-04" }, USA250, { now: NOW }),
    ).toBe(true);
    expect(
      isPromoEligibleLine({ domain: "bowling", visitDate: "2026-07-05" }, USA250, { now: NOW }),
    ).toBe(false);
    expect(isPromoEligibleLine({ domain: "bowling", visitDate: "2026-07-04" }, null)).toBe(false);
  });

  it("fails CLOSED for a date-scoped code when the line has no visit date", () => {
    // A date-scoped code must NOT discount a line whose date we couldn't read,
    // even though evaluateCode would skip the date check on a missing date.
    expect(isPromoEligibleLine({ domain: "racing" }, USA250, { now: NOW })).toBe(false);
    expect(promoFactor({ domain: "racing" }, USA250, { now: NOW })).toBe(1);
  });
});

describe("applyPromoToBillLines", () => {
  it("discounts only eligible lines; skips no-domain lines; mixed-date cart hits only July 4", () => {
    const lines: PromoableLine[] = [
      { amount: 20.99, domain: "racing", visitDate: "2026-07-04" }, // eligible
      { amount: 30.0, domain: "bowling", visitDate: "2026-07-06" }, // wrong date
      { amount: 4.99 }, // license: no domain → never discounted
    ];
    const out = applyPromoToBillLines(lines, USA250, { now: NOW });
    expect(out[0].amount).toBeCloseTo(15.74, 2);
    expect(out[0].originalAmount).toBe(20.99);
    expect(out[0].promoPct).toBe(25);
    expect(out[1].amount).toBe(30.0); // untouched (July 6)
    expect(out[1].originalAmount).toBeUndefined();
    expect(out[2].amount).toBe(4.99); // untouched (no domain)
  });

  it("is idempotent — a line already carrying originalAmount is left as-is", () => {
    const lines: PromoableLine[] = [
      {
        amount: 15.74,
        originalAmount: 20.99,
        promoPct: 25,
        domain: "racing",
        visitDate: "2026-07-04",
      },
    ];
    const out = applyPromoToBillLines(lines, USA250, { now: NOW });
    expect(out[0].amount).toBe(15.74); // not re-discounted to 11.80
    expect(out[0].originalAmount).toBe(20.99);
  });

  it("returns the lines unchanged when there is no promo", () => {
    const lines: PromoableLine[] = [{ amount: 20.99, domain: "racing", visitDate: "2026-07-04" }];
    expect(applyPromoToBillLines(lines, null, { now: NOW })).toBe(lines);
  });
});

describe("promoSavingsCents", () => {
  it("sums original − amount across discounted lines", () => {
    const lines: PromoableLine[] = [
      { amount: 15.74, originalAmount: 20.99, domain: "racing" },
      { amount: 22.5, originalAmount: 30.0, domain: "bowling" },
      { amount: 4.99 }, // not discounted
    ];
    // (20.99-15.74) + (30-22.5) = 5.25 + 7.50 = 12.75 → 1275 cents
    expect(promoSavingsCents(lines)).toBe(1275);
  });
});
