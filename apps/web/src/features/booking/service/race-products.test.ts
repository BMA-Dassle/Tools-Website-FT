import { describe, expect, it } from "vitest";
import {
  combineTrackVariants,
  filterProducts,
  getRaceProductById,
  isRelevantMembership,
  productsForSchedule,
  tierFromMemberships,
} from "./race-products";

describe("getRaceProductById", () => {
  it("finds a known weekday Starter Red (new)", () => {
    expect(getRaceProductById("24960859")?.name).toBe("Starter Race Red");
    expect(getRaceProductById("24960859")?.tier).toBe("starter");
    expect(getRaceProductById("24960859")?.track).toBe("Red");
  });

  it("accepts numeric ids", () => {
    expect(getRaceProductById(24960859)?.tier).toBe("starter");
  });

  it("returns null for unknown / nullish ids", () => {
    expect(getRaceProductById(null)).toBeNull();
    expect(getRaceProductById(undefined)).toBeNull();
    expect(getRaceProductById("99999999")).toBeNull();
  });

  it("reconstructs a combined-track product from its m: id (track keys preserved)", () => {
    // sorted Blue(43734325) + Red(43734615) weekday-existing Starter
    const c = getRaceProductById("m:43734325:43734615");
    expect(c?.name).toBe("Starter Race");
    expect(c?.track).toBeNull();
    expect(c?.trackProducts?.Red?.productId).toBe("43734615");
    expect(c?.trackProducts?.Blue?.productId).toBe("43734325");
  });

  it("includes 3-pack day-of combo products", () => {
    expect(getRaceProductById("45094787")?.packType).toBe("combo");
    expect(getRaceProductById("45094787")?.raceCount).toBe(3);
  });

  it("mixed-track 3-pack exposes track-keyed product map", () => {
    const pack = getRaceProductById("45094857"); // Intermediate Weekday 3-Pack
    expect(pack?.trackProducts).toBeDefined();
    expect(pack?.trackProducts?.Red?.productId).toBe("45094857");
    expect(pack?.trackProducts?.Blue?.productId).toBe("45094906");
  });
});

describe("productsForSchedule", () => {
  it("weekday + new = page 24961568/25850629/25850669 products", () => {
    const ps = productsForSchedule("weekday", "new");
    const ids = ps.map((p) => p.productId);
    expect(ids).toContain("24960859"); // Starter Red
    expect(ids).toContain("24963023"); // Pro Red
    expect(ps.every((p) => p.schedule === "weekday")).toBe(true);
    expect(ps.every((p) => p.racerType === "new")).toBe(true);
  });

  it("mega + existing = page 43734751 + 3-pack products", () => {
    const ps = productsForSchedule("mega", "existing");
    const ids = ps.map((p) => p.productId);
    expect(ids).toContain("43734407"); // Starter Race Mega (returning)
    expect(ids).toContain("45094787"); // Pro Mega 3-Pack
    expect(ps.every((p) => p.schedule === "mega")).toBe(true);
  });

  it("weekend + new has no Pro tier (v1 parity)", () => {
    const ps = productsForSchedule("weekend", "new");
    expect(ps.some((p) => p.tier === "pro")).toBe(false);
    expect(ps.some((p) => p.tier === "intermediate")).toBe(true);
  });
});

describe("filterProducts", () => {
  const weekdayNew = productsForSchedule("weekday", "new");
  const weekdayExisting = productsForSchedule("weekday", "existing");

  it("new racers see only Starter regardless of party size", () => {
    const out = filterProducts(weekdayNew, {
      racerType: "new",
      adultCount: 2,
      juniorCount: 1,
    });
    expect(out.every((p) => p.tier === "starter")).toBe(true);
  });

  it("returning + no qualification → Starter only", () => {
    const out = filterProducts(weekdayExisting, {
      racerType: "existing",
      adultCount: 2,
      juniorCount: 0,
    });
    expect(out.every((p) => p.tier === "starter")).toBe(true);
  });

  it("returning + Intermediate qualification → Starter + Intermediate", () => {
    const out = filterProducts(weekdayExisting, {
      racerType: "existing",
      adultCount: 1,
      juniorCount: 0,
      memberships: ["Intermediate Qualified"],
    });
    const tiers = new Set(out.map((p) => p.tier));
    expect(tiers).toEqual(new Set(["starter", "intermediate"]));
  });

  it("returning + Pro qualification → all tiers", () => {
    const out = filterProducts(weekdayExisting, {
      racerType: "existing",
      adultCount: 1,
      juniorCount: 0,
      memberships: ["Pro Qualified"],
    });
    const tiers = new Set(out.map((p) => p.tier));
    expect(tiers).toEqual(new Set(["starter", "intermediate", "pro"]));
  });

  it("hides adult products when adultCount = 0", () => {
    const out = filterProducts(weekdayNew, {
      racerType: "new",
      adultCount: 0,
      juniorCount: 1,
    });
    expect(out.every((p) => p.category === "junior")).toBe(true);
  });

  it("hides junior products when juniorCount = 0", () => {
    const out = filterProducts(weekdayNew, {
      racerType: "new",
      adultCount: 2,
      juniorCount: 0,
    });
    expect(out.every((p) => p.category === "adult")).toBe(true);
  });

  it("never returns packType=sell products (credit packs broken in BMI)", () => {
    const out = filterProducts(weekdayExisting, {
      racerType: "existing",
      adultCount: 2,
      juniorCount: 0,
      memberships: ["Pro Qualified"],
    });
    expect(out.every((p) => p.packType !== "sell")).toBe(true);
  });
});

describe("tierFromMemberships", () => {
  it("Pro keyword wins over Intermediate + Starter", () => {
    expect(tierFromMemberships(["Pro Qualified", "Intermediate Qualified"])).toBe("Pro");
  });

  it("Intermediate keyword without Pro", () => {
    expect(tierFromMemberships(["Intermediate Qualified"])).toBe("Intermediate");
  });

  it("falls back to Starter on no matching memberships", () => {
    expect(tierFromMemberships([])).toBe("Starter");
    expect(tierFromMemberships(["Birthday Membership"])).toBe("Starter");
  });

  it("case-insensitive match", () => {
    expect(tierFromMemberships(["PRO RACER"])).toBe("Pro");
    expect(tierFromMemberships(["intermediate qualified"])).toBe("Intermediate");
  });
});

describe("isRelevantMembership", () => {
  it("flags license fee + tier qualifications + turbo pass + employee + race credit", () => {
    expect(isRelevantMembership("Intermediate Qualified")).toBe(true);
    expect(isRelevantMembership("Pro Qualified")).toBe(true);
    expect(isRelevantMembership("License Fee")).toBe(true);
    expect(isRelevantMembership("Turbo Pass")).toBe(true);
    expect(isRelevantMembership("Employee Pass")).toBe(true);
    expect(isRelevantMembership("Race Credit Bundle")).toBe(true);
  });

  it("rejects unrelated memberships", () => {
    expect(isRelevantMembership("Birthday Membership")).toBe(false);
    expect(isRelevantMembership("VIP Lounge")).toBe(false);
  });
});

describe("combineTrackVariants — merge Red+Blue singles, keep per-track keys", () => {
  it("collapses adult Red+Blue Starter into ONE combined card spanning both tracks", () => {
    const starters = productsForSchedule("weekday", "existing").filter(
      (p) => p.category === "adult" && p.tier === "starter" && !p.packType,
    );
    // sanity: the catalog really has separate Red + Blue singles
    expect(new Set(starters.map((p) => p.track))).toEqual(new Set(["Red", "Blue"]));

    const combined = combineTrackVariants(starters);
    expect(combined).toHaveLength(1);
    const c = combined[0];
    expect(c.name).toBe("Starter Race");
    expect(c.track).toBeNull();
    expect(c.productId.startsWith("m:")).toBe(true);
    // both ORIGINAL per-track product ids survive → each heat still books its own key
    expect(c.trackProducts?.Red?.productId).toBe("43734615");
    expect(c.trackProducts?.Blue?.productId).toBe("43734325");
  });

  it("leaves single-track (Mega) and combos unmerged", () => {
    const mega = productsForSchedule("mega", "existing").filter((p) => p.category === "adult");
    const combined = combineTrackVariants(mega);
    // one track per Mega tier → nothing collapses into an m: combined product
    expect(combined.some((p) => p.productId.startsWith("m:"))).toBe(false);
    // combos pass through untouched
    expect(combined.find((p) => p.productId === "45094787")?.packType).toBe("combo");
  });

  it("passes junior (Blue-only) through unchanged", () => {
    const juniors = productsForSchedule("weekday", "existing").filter(
      (p) => p.category === "junior",
    );
    const combined = combineTrackVariants(juniors);
    expect(combined.some((p) => p.productId.startsWith("m:"))).toBe(false);
  });
});
