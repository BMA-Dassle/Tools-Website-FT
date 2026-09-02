import { describe, expect, it } from "vitest";
import { shoesIncludedInExperience } from "./bowling-offer";

/**
 * "Does this package include shoes" was written out THREE times — the web shoe
 * step, the kiosk details step, and the QAMF note the front desk reads — and all
 * three had to be updated by hand whenever a package was added. NFL Ticket
 * updated none of them: it advertises "shoes … included" in its own subtitle,
 * charged for them in the wizard, and stamped "SHOES NOT INCLUDED" on the
 * reservation so the desk would have charged again.
 * Owner, 2026-09-01: "the package includes shoes and its charging."
 *
 * There is now one predicate. This is the test that stops it drifting a fourth
 * time — it is a money path in both directions: charge for something included,
 * or give away something billable.
 */

describe("shoesIncludedInExperience", () => {
  it("includes shoes for BOTH NFL day bands", () => {
    expect(shoesIncludedInExperience("nfl-vip-fri-sun")).toBe(true);
    expect(shoesIncludedInExperience("nfl-vip-mon-thur")).toBe(true);
  });

  it("matches NFL by PREFIX, so a new band or center cannot start charging", () => {
    // The package is sold through day-banded slugs because the Conqueror offers
    // behind it are day-banded. A third band is a seed change, not a deploy —
    // it must not silently begin charging for shoes.
    expect(shoesIncludedInExperience("nfl-vip-sat-only")).toBe(true);
    expect(shoesIncludedInExperience("nfl-vip-naples-fri-sun")).toBe(true);
  });

  it("keeps the packages that already bundled shoes", () => {
    for (const slug of ["fun-4-all", "fun-4-all-vip", "pizza-bowl", "pizza-bowl-vip"]) {
      expect(shoesIncludedInExperience(slug), slug).toBe(true);
    }
  });

  it("does NOT include shoes for World Cup — that package priced them separately", () => {
    // The reference implementation NFL was modelled on deliberately excluded
    // them, which is exactly why copying it blind produced this bug.
    expect(shoesIncludedInExperience("world-cup-vip-fri-sun")).toBe(false);
    expect(shoesIncludedInExperience("world-cup-vip-mon-thur")).toBe(false);
  });

  it("does NOT include shoes for ordinary bowling", () => {
    for (const slug of ["open-play", "vip-fri-sun", "pinboyz-classic", "kbf-regular"]) {
      expect(shoesIncludedInExperience(slug), slug).toBe(false);
    }
  });

  it("is safe on a missing slug — an unconfigured item never gives shoes away", () => {
    expect(shoesIncludedInExperience(null)).toBe(false);
    expect(shoesIncludedInExperience(undefined)).toBe(false);
    expect(shoesIncludedInExperience("")).toBe(false);
  });

  it("does not match a lookalike prefix", () => {
    // "nfl-vip" without the band separator is not a real slug; requiring the
    // trailing dash keeps the prefix test from becoming a substring test.
    expect(shoesIncludedInExperience("nfl-vipsomething")).toBe(false);
    expect(shoesIncludedInExperience("not-nfl-vip-fri-sun")).toBe(false);
  });
});
