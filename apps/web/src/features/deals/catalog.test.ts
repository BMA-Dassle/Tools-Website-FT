import { describe, it, expect } from "vitest";
import {
  DEAL_CATALOG,
  DEAL_LOCATIONS,
  dealExpiryFrom,
  dealIsSellable,
  dealValue,
  getDeal,
  isDealLocation,
} from "./catalog";

describe("deal catalog shape", () => {
  it("has the two packs the owner priced", () => {
    expect(DEAL_CATALOG.map((d) => [d.slug, d.priceCents])).toEqual([
      ["laser-tag-game-card-pack", 3400],
      ["gel-blaster-game-card-pack", 4500],
    ]);
  });

  it("mints TWO qty:1 admissions, never one qty:2", () => {
    // Coverage is awarded one unit per APPLIED SESSION ENTRY, and claims are
    // unique per (code, itemIndex). A single qty:2 item would cover one unit and
    // silently charge for the second, and could not be split across visits.
    for (const deal of DEAL_CATALOG) {
      const admissions = deal.items.filter((i) => i.kind === "attraction");
      expect(admissions).toHaveLength(2);
      for (const item of admissions) {
        expect(item).toEqual({ kind: "attraction", slug: deal.scheduleSlug, qty: 1 });
      }
    }
  });

  it("mints two separate game-card items with comped value in the BONUS bucket", () => {
    const laser = getDeal("laser-tag-game-card-pack")!;
    expect(laser.items.filter((i) => i.kind === "gamezone")).toEqual([
      { kind: "gamezone", tokens: 0, bonusTokens: 100, bonusCashDollars: 0 },
      { kind: "gamezone", tokens: 0, bonusTokens: 100, bonusCashDollars: 0 },
    ]);
    const gel = getDeal("gel-blaster-game-card-pack")!;
    expect(gel.items.filter((i) => i.kind === "gamezone")).toEqual([
      { kind: "gamezone", tokens: 0, bonusTokens: 150, bonusCashDollars: 0 },
      { kind: "gamezone", tokens: 0, bonusTokens: 150, bonusCashDollars: 0 },
    ]);
  });

  it("every game-card denomination is on the MINT allowlist", async () => {
    // mintVouchers throws on an off-allowlist denomination, so a bad number here
    // would break the purchase at capture time — after the guest has paid.
    const { NATIVE_GRANT_DENOMINATIONS } = await import(
      "~/features/game-cards/service/native-voucher"
    );
    for (const deal of DEAL_CATALOG) {
      for (const item of deal.items) {
        if (item.kind === "gamezone") {
          expect(NATIVE_GRANT_DENOMINATIONS).toContain(item.bonusTokens);
        }
      }
    }
  });

  it("is sellable — every deal carries a Square catalog id", () => {
    // Charging without one books revenue that is invisible in QBO and cannot be
    // retro-fitted onto a captured payment, so buildDealOrder refuses.
    for (const deal of DEAL_CATALOG) {
      expect(dealIsSellable(deal), `${deal.slug} has no Square catalog id`).toBe(true);
    }
  });

  it("points at the live Square variations, not item ids", () => {
    // Pinned literally: these were read off the Square Catalog API, and a
    // dashboard column clipped them (the laser id's 9th char is P, not F). A typo
    // here fails at order-create, after the buyer has filled the form in.
    expect(getDeal("laser-tag-game-card-pack")!.squareCatalogId).toBe(
      "FGDAFYAVPFJ2GRRZQXNHZJB6",
    );
    expect(getDeal("gel-blaster-game-card-pack")!.squareCatalogId).toBe(
      "B6ST5YMWFNLL66PVQXVXXYFY",
    );
    // Square catalog ids are 24 chars here — a clipped paste is the likely error.
    for (const deal of DEAL_CATALOG) {
      expect(deal.squareCatalogId).toHaveLength(24);
    }
  });

  it("resolves and rejects location keys", () => {
    expect(DEAL_LOCATIONS).toEqual(["headpinz", "naples"]);
    expect(isDealLocation("naples")).toBe(true);
    expect(isDealLocation("headpinz")).toBe(true);
    expect(isDealLocation("fasttrax")).toBe(false); // FastTrax sells neither
    expect(isDealLocation("")).toBe(false);
  });

  it("returns null for an unknown slug", () => {
    expect(getDeal("nope")).toBeNull();
  });
});

describe("dealValue — the advertised strikethrough", () => {
  it("prices the laser pack at $44 à la carte, a 22% saving", () => {
    const v = dealValue(getDeal("laser-tag-game-card-pack")!, "headpinz");
    expect(v.lines).toEqual([
      { label: "2 × Laser Tag (15 min session)", cents: 2000 },
      { label: "2 × game card ($10 + $10 of play)", cents: 2000 },
      { label: "2 × new-card activation fee", cents: 400 },
    ]);
    expect(v.compareAtCents).toBe(4400);
    expect(v.savingsCents).toBe(1000);
    // 1000/4400 = 22.7% — floored, because a discount must never be overstated.
    expect(v.savingsPct).toBe(22);
  });

  it("prices the gel pack at $58 à la carte, a 22% saving", () => {
    const v = dealValue(getDeal("gel-blaster-game-card-pack")!, "headpinz");
    expect(v.lines).toEqual([
      { label: "2 × Gel Blasters (15 min session)", cents: 2400 },
      { label: "2 × game card ($15 + $15 of play)", cents: 3000 },
      { label: "2 × new-card activation fee", cents: 400 },
    ]);
    expect(v.compareAtCents).toBe(5800);
    expect(v.savingsCents).toBe(1300);
    expect(v.savingsPct).toBe(22);
  });

  it("prices every deal at every location it is sold for", () => {
    // A deal offered at a location with no product there would throw — which is
    // the point: an under-stated "value" is a false advertising claim.
    for (const deal of DEAL_CATALOG) {
      for (const location of deal.locations) {
        const v = dealValue(deal, location);
        expect(v.compareAtCents).toBeGreaterThan(deal.priceCents);
        expect(v.savingsPct).toBeGreaterThan(0);
      }
    }
  });

  it("throws rather than under-stating when a product is missing at a location", () => {
    const bogus = {
      ...getDeal("laser-tag-game-card-pack")!,
      items: [{ kind: "attraction" as const, slug: "duck-pin", qty: 1 }],
    };
    // Duckpin is FastTrax-only — there is no Naples product.
    expect(() => dealValue(bogus, "naples")).toThrow(/no duck-pin product at naples/);
  });
});

describe("dealExpiryFrom", () => {
  it("is 12 months out, end of day ET", () => {
    expect(dealExpiryFrom(new Date("2026-08-02T14:30:00Z"), 12)).toBe("2027-08-02T23:59:59-05:00");
  });

  it("rolls the year and clamps a short month the way Date does", () => {
    expect(dealExpiryFrom(new Date("2026-01-15T12:00:00Z"), 12)).toBe("2027-01-15T23:59:59-05:00");
  });
});
