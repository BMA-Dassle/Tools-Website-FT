import { describe, it, expect } from "vitest";
import {
  RACE_WARNINGS,
  JUNIOR_STARTER_WARNING,
  raceWarningFor,
  raceWarningMemo,
} from "./race-warnings";
import { _allRaceProducts } from "./race-products";
import { _allPackages } from "@/lib/packages";

/**
 * Driven by the LIVE registries, not fixtures. A hand-written
 * `{ tier: "starter", category: "junior" }` object proves the predicate reads
 * its own arguments; running every real Junior Starter SKU through it proves
 * the warning actually reaches the products guests can buy — which is the thing
 * that breaks when someone adds a schedule variant.
 */

const NO_MEMBERSHIPS: string[] = [];
const JUNIOR_INTERMEDIATE = ["Qualified Junior Intermediate"];

describe("raceWarningFor — single race products", () => {
  const products = _allRaceProducts();

  it("fires on EVERY Junior Starter product in the catalog", () => {
    const juniorStarters = products.filter((p) => p.category === "junior" && p.tier === "starter");
    // Guard the guard: if the catalog stops containing junior starters this
    // test would pass vacuously.
    expect(juniorStarters.length).toBeGreaterThan(0);
    for (const product of juniorStarters) {
      expect(
        raceWarningFor({ category: "junior", memberships: NO_MEMBERSHIPS, product }),
        `expected a warning for ${product.name} (${product.productId})`,
      ).toBe(JUNIOR_STARTER_WARNING);
    }
  });

  it("never fires on an adult product, at any tier", () => {
    for (const product of products.filter((p) => p.category === "adult")) {
      expect(
        raceWarningFor({ category: "adult", memberships: NO_MEMBERSHIPS, product }),
        `unexpected warning for ${product.name} (${product.productId})`,
      ).toBeNull();
    }
  });

  it("never fires on a junior product above Starter", () => {
    const higher = products.filter((p) => p.category === "junior" && p.tier !== "starter");
    expect(higher.length).toBeGreaterThan(0);
    for (const product of higher) {
      expect(
        raceWarningFor({ category: "junior", memberships: NO_MEMBERSHIPS, product }),
        `unexpected warning for ${product.name} (${product.productId})`,
      ).toBeNull();
    }
  });

  it("stops firing once the junior has outgrown Starter", () => {
    const product = products.find((p) => p.category === "junior" && p.tier === "starter")!;
    expect(
      raceWarningFor({ category: "junior", memberships: NO_MEMBERSHIPS, product }),
    ).not.toBeNull();
    // Already Intermediate: they know what Starter is, and the Ultimate
    // Qualifier is not offered to them (maxQualifiedTier), so the modal would
    // recommend a package they cannot buy.
    expect(
      raceWarningFor({ category: "junior", memberships: JUNIOR_INTERMEDIATE, product }),
    ).toBeNull();
    expect(
      raceWarningFor({ category: "junior", memberships: ["Qualified Junior Pro"], product }),
    ).toBeNull();
  });

  it("trusts the product's own category over the caller's", () => {
    const adultStarter = products.find((p) => p.category === "adult" && p.tier === "starter")!;
    // A mis-wired junior step must not show junior copy for an adult race.
    expect(
      raceWarningFor({ category: "junior", memberships: NO_MEMBERSHIPS, product: adultStarter }),
    ).toBeNull();
  });

  it("returns null when nothing is selected", () => {
    expect(raceWarningFor({ category: "junior", memberships: NO_MEMBERSHIPS })).toBeNull();
  });
});

describe("raceWarningFor — packages", () => {
  const packages = _allPackages();

  it("fires on every junior Rookie Pack — a Starter race is still a Starter race", () => {
    const juniorRookie = packages.filter(
      (p) => p.id.startsWith("rookie-pack") && p.category === "junior",
    );
    expect(juniorRookie.length).toBeGreaterThan(0);
    for (const pkg of juniorRookie) {
      expect(
        raceWarningFor({ category: "junior", memberships: NO_MEMBERSHIPS, packageId: pkg.id }),
        `expected a warning for ${pkg.id}`,
      ).toBe(JUNIOR_STARTER_WARNING);
    }
  });

  it("never fires on a package that already includes an Intermediate heat", () => {
    // Ultimate Qualifier IS the upsell; BOGO bundles an Intermediate too. Both
    // carry their own disclaimer — warning here would stack two modals.
    const bundled = packages.filter(
      (p) => p.id.startsWith("ultimate-qualifier") || p.id.startsWith("bogo"),
    );
    expect(bundled.length).toBeGreaterThan(0);
    for (const pkg of bundled) {
      expect(
        raceWarningFor({ category: "junior", memberships: NO_MEMBERSHIPS, packageId: pkg.id }),
        `unexpected warning for ${pkg.id}`,
      ).toBeNull();
    }
  });

  it("matches the package FAMILY by prefix, never by substring", () => {
    // `.includes("rookie-pack")` would match this; `.startsWith` does not.
    // Substring matching on ids is what let a junior pro book adult Pro.
    expect(
      raceWarningFor({
        category: "junior",
        memberships: NO_MEMBERSHIPS,
        packageId: "combo-with-rookie-pack-extra",
      }),
    ).toBeNull();
  });

  it("every warn-listed package prefix exists in the package registry", () => {
    // A renamed package family would otherwise silently stop warning.
    for (const warning of RACE_WARNINGS) {
      for (const prefix of warning.warnOnPackagePrefixes) {
        expect(
          packages.some((p) => p.id.startsWith(prefix) && p.category === warning.category),
          `no ${warning.category} package matches prefix "${prefix}"`,
        ).toBe(true);
      }
      if (warning.upsellPackagePrefix) {
        expect(
          packages.some(
            (p) => p.id.startsWith(warning.upsellPackagePrefix!) && p.category === warning.category,
          ),
          `no ${warning.category} package matches upsell prefix "${warning.upsellPackagePrefix}"`,
        ).toBe(true);
      }
    }
  });
});

describe("registry integrity", () => {
  it("at most one warning can match any category + tier", () => {
    // raceWarningFor returns the FIRST match; two matching records would make
    // which one a guest sees depend on array order.
    const seen = new Set<string>();
    for (const w of RACE_WARNINGS) {
      const key = `${w.category}:${w.tier}`;
      expect(seen.has(key), `two warnings both claim ${key}`).toBe(false);
      seen.add(key);
    }
  });

  it("no warning lists its own upsell as a thing to warn about", () => {
    for (const w of RACE_WARNINGS) {
      if (!w.upsellPackagePrefix) continue;
      expect(
        w.warnOnPackagePrefixes.some((p) => p.startsWith(w.upsellPackagePrefix!)),
        `${w.id} would warn about the package it recommends`,
      ).toBe(false);
    }
  });

  it("ids are unique — the memo is looked up by id", () => {
    const ids = RACE_WARNINGS.map((w) => w.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("raceWarningMemo", () => {
  it("returns the staff memo for an acknowledged warning", () => {
    const memo = raceWarningMemo(JUNIOR_STARTER_WARNING.id);
    expect(memo).toContain("JUNIOR STARTER — UPGRADE DECLINED");
    expect(memo).toContain("Ultimate Qualifier");
  });

  it("returns null when nothing was acknowledged", () => {
    // The memo must never claim an acknowledgement that did not happen.
    expect(raceWarningMemo(null)).toBeNull();
    expect(raceWarningMemo(undefined)).toBeNull();
    expect(raceWarningMemo("")).toBeNull();
    expect(raceWarningMemo("no-such-warning")).toBeNull();
  });
});
