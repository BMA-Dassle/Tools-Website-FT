import { describe, expect, it } from "vitest";
import { DEAL_CATALOG, dealSeoValue, getDeal } from "./catalog";
import { money } from "./format";
import { dealDiscountPct, dealSeoDescription, dealSeoTitle, dealsHubSeo } from "./seo";

/**
 * Search copy is an ADVERTISED CLAIM, so these tests are about the ways it can
 * lie: stating a price the page does not charge, claiming a bigger discount than
 * is given, and — the subtle one the owner caught — hanging the deadline on the
 * COMBINED saving when only part of it expires.
 */

const laser = getDeal("laser-tag-game-card-pack")!;
const gel = getDeal("gel-blaster-game-card-pack")!;

const sale = { unitPriceCents: 2550, regularPriceCents: 3400, endsAt: "2026-09-13T23:59:59-04:00" };
const regular = { unitPriceCents: 3400, regularPriceCents: 3400, endsAt: null };
const saleValue = dealSeoValue(laser, sale.unitPriceCents);
const regularValue = dealSeoValue(laser, regular.unitPriceCents);

describe("dealDiscountPct", () => {
  it("measures the markdown against the REGULAR price — the part that expires", () => {
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

describe("the two stacked discounts", () => {
  it("compounds rather than adds — 22% then 25% is 42% off, not 47%", () => {
    // The pack's standing saving against à la carte...
    expect(dealSeoValue(laser, laser.priceCents).savingsPct).toBe(22);
    // ...and the flash sale on top of it.
    expect(dealDiscountPct(sale)).toBe(25);
    // Compounded, not summed. $25.50 of a $44 à-la-carte basket.
    expect(saleValue.savingsPct).toBe(42);
    expect(saleValue.compareAtCents).toBe(4400);
    expect(saleValue.savingsCents).toBe(1850);
  });

  it("does the same for the gel pack, which lands a point lower", () => {
    const v = dealSeoValue(gel, 3375);
    expect(dealSeoValue(gel, gel.priceCents).savingsPct).toBe(22);
    expect(v.savingsPct).toBe(41);
    expect(v.savingsCents).toBe(2425);
  });
});

describe("dealSeoTitle", () => {
  it("states the price the page actually charges", () => {
    expect(dealSeoTitle(laser, regular, regularValue)).toBe(
      "Laser Tag Deal — 2 Players + $20 Arcade for $34",
    );
  });

  it("leads with the COMBINED saving, matching the badge on the page", () => {
    expect(dealSeoTitle(laser, sale, saleValue)).toBe(
      "Laser Tag Deal — 42% Off: 2 Players + $20 Arcade for $25.50",
    );
  });

  it("leaves the standing discount unstated when no sale runs", () => {
    // The pack is permanently 22% off, but a title that always says so is
    // furniture. Only a real markdown earns the headline.
    expect(dealSeoTitle(laser, regular, regularValue)).not.toMatch(/%/);
  });

  it("throws on a template nobody filled, rather than indexing a raw token", () => {
    const broken = { ...laser, seo: { ...laser.seo, title: "Deal for {prcie}" } };
    expect(() => dealSeoTitle(broken, regular, regularValue)).toThrow(/unfilled token \{prcie\}/);
  });
});

describe("dealSeoDescription", () => {
  it("states the live price and nothing about a sale when none runs", () => {
    const text = dealSeoDescription(laser, regular, regularValue);
    expect(text).toContain("for $34");
    expect(text).not.toMatch(/save|extra/i);
  });

  it("leads with the money and hangs the deadline on the EXPIRING part only", () => {
    const text = dealSeoDescription(laser, sale, saleValue);
    expect(text).toBe(
      "Save $18.50 (42% off a $44 value) — two Nexus Laser Tag sessions plus $20 in " +
        "Game Zone Tokens for $25.50 at HeadPinz Fort Myers and Naples. " +
        "Extra 25% off through Sunday, September 13.",
    );
    // The thing that ends is the 25%, never the 42%: after the sale the pack is
    // still 22% off, so a deadline on the combined figure would overstate it.
    expect(text).not.toMatch(/42% off through/);
  });

  it("says 'for a limited time' rather than inventing a deadline we never set", () => {
    const text = dealSeoDescription(laser, { ...sale, endsAt: null }, saleValue);
    expect(text).toContain("Extra 25% off for a limited time.");
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
        const value = dealSeoValue(deal, offer.unitPriceCents);
        const title = dealSeoTitle(deal, offer, value);
        const description = dealSeoDescription(deal, offer, value);
        expect(title).not.toMatch(/[{}]/);
        expect(description).not.toMatch(/[{}]/);
        // A title Google truncates mid-price is worse than a shorter one. 65 is
        // about where the pixel budget runs out for these characters.
        expect(title.length).toBeLessThanOrEqual(65);
        // The descriptions run past Google's ~155-character cut, which is fine
        // — what is NOT fine is the cut landing before the offer. Everything
        // that has to survive is asserted inside the visible head rather than
        // the copy being squeezed to an arbitrary length.
        const visible = description.slice(0, 155);
        expect(visible).toContain(money(offer.unitPriceCents));
        expect(visible).toContain("HeadPinz Fort Myers and Naples");
        if (offer.unitPriceCents < offer.regularPriceCents) {
          expect(visible).toContain(`Save ${money(value.savingsCents)}`);
          expect(visible).toContain(`${value.savingsPct}% off`);
        }
      }
    }
  });

  it("keeps a typed dollar amount or percentage out of the templates entirely", () => {
    // The pack PRICE and every discount claim must come from the offer. Other
    // dollar figures in the copy ($20 of tokens) are contents, not the price,
    // and are allowed to be written down — but a price or a percent never is.
    for (const deal of DEAL_CATALOG) {
      const priced = `$${deal.priceCents / 100}`;
      for (const template of [deal.seo.title, deal.seo.description, deal.seo.saleDescription]) {
        expect(template).not.toContain(priced);
        expect(template).not.toMatch(/\d+%/);
      }
      expect(deal.seo.title).toContain("{price}");
      expect(deal.seo.title).toContain("{off}");
      expect(deal.seo.description).toContain("{price}");
      expect(deal.seo.saleDescription).toContain("{price}");
      expect(deal.seo.saleDescription).toContain("{salePct}");
      expect(deal.seo.saleDescription).toContain("{deadline}");
    }
  });
});

describe("dealsHubSeo", () => {
  // The real copy from app/deals/page.tsx, so the length caps below are the
  // actual shipped strings rather than a fixture that flatters them.
  const copy = {
    brand: "HeadPinz Deals",
    tail: "Laser Tag, Gel Blaster & Arcade Packs",
    saleTail: "Laser Tag & Gel Blaster Packs",
    description:
      "Prepaid packs at HeadPinz Fort Myers and Naples: two laser tag or gel blaster sessions bundled with arcade game cards, for less than buying them separately.",
  };
  const entries = [
    { offer: sale, value: saleValue },
    {
      offer: { ...sale, unitPriceCents: 3375, regularPriceCents: 4500 },
      value: dealSeoValue(gel, 3375),
    },
  ];

  it("says 'up to' when the packs do not share a figure", () => {
    // 42% and 41% — advertising 42% flat would overstate the gel pack.
    const { title, description } = dealsHubSeo(entries, copy);
    expect(title).toBe("HeadPinz Deals — Up to 42% Off Laser Tag & Gel Blaster Packs");
    expect(
      description.startsWith("Save up to 42% — extra 25% off through Sunday, September 13. "),
    ).toBe(true);
  });

  it("states the figure exactly when they agree", () => {
    const same = [entries[0], { ...entries[0] }];
    expect(dealsHubSeo(same, copy).title).toBe(
      "HeadPinz Deals — 42% Off Laser Tag & Gel Blaster Packs",
    );
  });

  it("falls back to the resting copy with no sale running", () => {
    const { title, description } = dealsHubSeo([{ offer: regular, value: regularValue }], copy);
    expect(title).toBe("HeadPinz Deals — Laser Tag, Gel Blaster & Arcade Packs");
    expect(description).toBe(copy.description);
  });

  it("keeps both title states inside what Google will render", () => {
    for (const t of [
      dealsHubSeo(entries, copy).title,
      dealsHubSeo([{ offer: regular, value: regularValue }], copy).title,
    ]) {
      expect(t.length).toBeLessThanOrEqual(65);
    }
  });
});

describe("dealSeoValue", () => {
  it("quotes the SMALLEST saving across a deal's venues", () => {
    // One canonical URL serves both, so the number has to hold wherever the
    // click lands. Identical pricing today — this guards the day it is not.
    for (const deal of DEAL_CATALOG) {
      const seo = dealSeoValue(deal, deal.priceCents);
      for (const location of deal.locations) {
        const here = dealSeoValue({ ...deal, locations: [location] }, deal.priceCents);
        expect(seo.savingsPct).toBeLessThanOrEqual(here.savingsPct);
      }
    }
  });
});
