import { describe, expect, it } from "vitest";
import {
  combineTrackVariants,
  filterProducts,
  getRaceProductById,
  isQualifiedForTier,
  isRelevantMembership,
  productsForSchedule,
  qualifiedTierForCategory,
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

// Mega runs JUNIOR PRO races only (owner 2026-08-05, effective 2026-08-10): BMI
// never had a Junior Starter Mega product, and Junior Intermediate Mega
// (24966320 new / 43732358 existing) was retired from the catalog. Guard it in
// the registry, because these entries are exactly the kind of thing a future
// "restore parity with v1" edit puts back by accident.
describe("Mega junior products — Junior Pro only", () => {
  for (const racerType of ["new", "existing"] as const) {
    it(`mega + ${racerType} exposes junior PRO and nothing else junior`, () => {
      const juniorMega = productsForSchedule("mega", racerType).filter(
        (p) => p.category === "junior" && p.track === "Mega",
      );
      expect(juniorMega.length).toBeGreaterThan(0);
      expect(juniorMega.every((p) => p.tier === "pro")).toBe(true);
      expect(juniorMega.some((p) => p.tier === "starter")).toBe(false);
      expect(juniorMega.some((p) => p.tier === "intermediate")).toBe(false);
    });
  }

  it("the retired Junior Intermediate Mega ids resolve to nothing", () => {
    expect(getRaceProductById("24966320")).toBeNull();
    expect(getRaceProductById("43732358")).toBeNull();
  });

  it("adult Mega keeps every tier", () => {
    const adultMega = productsForSchedule("mega", "existing").filter(
      (p) => p.category === "adult" && p.track === "Mega" && !p.packType,
    );
    expect(adultMega.map((p) => p.tier).sort()).toEqual(["intermediate", "pro", "starter"]);
  });

  it("a junior qualified only to Intermediate gets NO Mega race", () => {
    const juniors = filterProducts(productsForSchedule("mega", "existing"), {
      racerType: "existing",
      adultCount: 0,
      juniorCount: 2,
      memberships: ["Qualified Junior Intermediate"],
    });
    expect(juniors).toEqual([]);
  });

  it("a Junior Pro racer gets exactly the Junior Pro Mega race", () => {
    const juniors = filterProducts(productsForSchedule("mega", "existing"), {
      racerType: "existing",
      adultCount: 0,
      juniorCount: 1,
      memberships: ["Qualified Junior Pro"],
    });
    expect(juniors.map((p) => p.productId)).toEqual(["43732675"]);
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

  // 2026-07-30 incident (bill 63000000006631238): "Qualified Junior Pro"
  // substring-matched "pro" and unlocked adult Pro Race for a 13-year-old
  // holding only junior qualifications.
  it("junior qualifications do NOT unlock adult Intermediate/Pro", () => {
    const out = filterProducts(weekdayExisting, {
      racerType: "existing",
      adultCount: 1,
      juniorCount: 0,
      memberships: ["License Fee", "Qualified Junior Intermediate", "Qualified Junior Pro"],
    });
    expect(out.length).toBeGreaterThan(0);
    expect(out.every((p) => p.tier === "starter")).toBe(true);
  });

  it("junior qualifications still unlock junior tiers", () => {
    const out = filterProducts(weekdayExisting, {
      racerType: "existing",
      adultCount: 0,
      juniorCount: 1,
      memberships: ["Qualified Junior Pro"],
    });
    const juniorTiers = new Set(out.filter((p) => p.category === "junior").map((p) => p.tier));
    expect(juniorTiers.has("pro") || juniorTiers.has("intermediate")).toBe(true);
  });

  it("adult Pro qualification still unlocks adult Pro (no regression)", () => {
    const out = filterProducts(weekdayExisting, {
      racerType: "existing",
      adultCount: 1,
      juniorCount: 0,
      memberships: ["Qualified Pro"],
    });
    expect(new Set(out.map((p) => p.tier))).toEqual(new Set(["starter", "intermediate", "pro"]));
  });
});

describe("qualifiedTierForCategory / isQualifiedForTier", () => {
  const juniorProOnly = ["License Fee", "Qualified Junior Intermediate", "Qualified Junior Pro"];

  it("junior quals rate as Starter in the adult category", () => {
    expect(qualifiedTierForCategory(juniorProOnly, "adult")).toBe("starter");
    expect(isQualifiedForTier(juniorProOnly, "adult", "pro")).toBe(false);
    expect(isQualifiedForTier(juniorProOnly, "adult", "intermediate")).toBe(false);
    expect(isQualifiedForTier(juniorProOnly, "adult", "starter")).toBe(true);
  });

  it("junior quals rate at their tier in the junior category", () => {
    expect(qualifiedTierForCategory(juniorProOnly, "junior")).toBe("pro");
    expect(isQualifiedForTier(juniorProOnly, "junior", "pro")).toBe(true);
  });

  it("adult quals count for both categories", () => {
    expect(qualifiedTierForCategory(["Qualified Pro"], "adult")).toBe("pro");
    expect(qualifiedTierForCategory(["Qualified Pro"], "junior")).toBe("pro");
    expect(qualifiedTierForCategory(["Qualified Intermediate"], "adult")).toBe("intermediate");
  });

  it("mixed junior + adult quals: each category sees its own ceiling", () => {
    const mixed = ["Qualified Junior Pro", "Qualified Intermediate"];
    expect(qualifiedTierForCategory(mixed, "adult")).toBe("intermediate");
    expect(qualifiedTierForCategory(mixed, "junior")).toBe("pro");
  });

  it("no quals → starter everywhere", () => {
    expect(qualifiedTierForCategory([], "adult")).toBe("starter");
    expect(qualifiedTierForCategory(["Birthday Membership"], "junior")).toBe("starter");
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

  it("is DISPLAY-ONLY: a junior pro still shows Pro (gate with isQualifiedForTier)", () => {
    expect(tierFromMemberships(["Qualified Junior Pro"])).toBe("Pro");
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
