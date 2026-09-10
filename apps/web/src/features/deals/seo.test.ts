import { describe, expect, it } from "vitest";
import { DEAL_CATALOG, getDeal, type DealCatalogEntry } from "./catalog";
import { money } from "./format";
import { dealDiscountPct, dealSeoDescription, dealSeoTitle } from "./seo";

/**
 * Search copy is an ADVERTISED CLAIM, so these tests are about the two ways it
 * can lie: stating a price the page does not charge, and stating a discount
 * bigger than the one being given. The shipped-catalog cases at the bottom are
 * the guard that a template never ships with a token nobody fills.
 */

const laser = getDeal("laser-tag-game-card-pack")!;

const sale = { unitPriceCents: 2550, regularPriceCents: 3400, endsAt: "2026-09-13T23:59:59-04:00" };
const regular = { unitPriceCents: 3400, regularPriceCents: 3400, endsAt: null };

describe("dealDiscountPct", () => {
  it("reports the whole percent off", () => {
    expect(dealDiscountPct(sale)).toBe(25);
    expect(dealDiscountPct({ ...sale, unitPriceCents: 3375, regularPriceCents: 4500 })).toBe(25);
  });

  it("is zero when nothing is discounted", () => {
    expect(dealDiscountPct(regular)).toBe(0);
    // A mark-up is not a discount. Never render "-12% off".
    expect(dealDiscountPct({ ...regular, unitPriceCents: 3800 })).toBe(0);
  });

  it("FLOORS rather than rounds, so the claim is never bigger than the discount", () => {
    // $34 → $25.51 is 24.97% off. Rounding would advertise 25%.
    expect(dealDiscountPct({ ...sale, unitPriceCents: 2551 })).toBe(24);
  });

  it("survives a zero regular price instead of dividing by it", () => {
    expect(dealDiscountPct({ unitPriceCents: 0, regularPriceCents: 0, endsAt: null })).toBe(0);
  });
});

describe("dealSeoTitle", () => {
  it("states the price the page actually charges", () => {
    expect(dealSeoTitle(laser, regular)).toBe("Laser Tag Deal — 2 Players + $20 Arcade for $34");
  });

  it("leads with the percent while a sale runs", () => {
    // The percent goes first because a truncated title keeps its head.
    expect(dealSeoTitle(laser, sale)).toBe(
      "25% Off: Laser Tag Deal — 2 Players + $20 Arcade for $25.50",
    );
  });

  it("throws on a template nobody filled, rather than indexing a raw token", () => {
    const broken = { ...laser, seo: { ...laser.seo, title: "Deal for {prcie}" } };
    expect(() => dealSeoTitle(broken, regular)).toThrow(/unfilled token \{prcie\}/);
  });
});

describe("dealSeoDescription", () => {
  it("states the live price and nothing about a sale when none runs", () => {
    const text = dealSeoDescription(laser, regular);
    expect(text).toContain("for $34");
    expect(text).not.toMatch(/save|off/i);
  });

  it("puts the saving and the real deadline first, where truncation cannot reach", () => {
    const text = dealSeoDescription(laser, sale);
    expect(text.startsWith("Save 25% through Sunday, September 13 — ")).toBe(true);
    expect(text).toContain("for $25.50");
    // The à-la-carte value does not move with the sale price.
    expect(text).toContain("A $44 value");
  });

  it("says 'for a limited time' rather than inventing a deadline we never set", () => {
    const text = dealSeoDescription(laser, { ...sale, endsAt: null });
    expect(text.startsWith("Save 25% for a limited time — ")).toBe(true);
  });
});

describe("the shipped catalog's templates", () => {
  it("renders every deal in both states with no token left behind", () => {
    for (const deal of DEAL_CATALOG) {
      for (const offer of [
        { unitPriceCents: deal.priceCents, regularPriceCents: deal.priceCents, endsAt: null },
        {
          unitPriceCents: Math.round(deal.priceCents * 0.75),
          regularPriceCents: deal.priceCents,
          endsAt: "2026-09-13T23:59:59-04:00",
        },
      ]) {
        const title = dealSeoTitle(deal, offer);
        const description = dealSeoDescription(deal, offer);
        expect(title).not.toMatch(/[{}]/);
        expect(description).not.toMatch(/[{}]/);
        // A title Google truncates mid-price is worse than a shorter one. 65 is
        // about where the pixel budget runs out for these characters.
        expect(title.length).toBeLessThanOrEqual(65);
        // The descriptions run past Google's ~155-character cut, which is fine
        // — what is NOT fine is the cut landing before the offer. Everything
        // that has to survive is asserted inside the visible head rather than
        // the copy being squeezed to an arbitrary length: the saving, the price,
        // and where you can use it.
        const visible = description.slice(0, 155);
        expect(visible).toContain(money(offer.unitPriceCents));
        expect(visible).toContain("HeadPinz Fort Myers and Naples");
        if (offer.unitPriceCents < offer.regularPriceCents) {
          expect(visible).toContain("Save 25%");
          expect(visible).toContain("Sunday, September 13");
        }
      }
    }
  });

  it("keeps a typed dollar amount out of the templates entirely", () => {
    // The pack PRICE must come from the offer. Other dollar figures in the copy
    // ($20 of tokens, a $44 value) are contents and comparisons, not the price,
    // and are allowed to be written down — but the price never is.
    for (const deal of DEAL_CATALOG) {
      const priced = `$${deal.priceCents / 100}`;
      expect(deal.seo.title).toContain("{price}");
      expect(deal.seo.description).toContain("{price}");
      expect(deal.seo.title).not.toContain(priced);
      expect(deal.seo.description).not.toContain(priced);
    }
  });
});

/** Typed so a catalog shape change breaks this file rather than the pages. */
const _typecheck: DealCatalogEntry = laser;
void _typecheck;
