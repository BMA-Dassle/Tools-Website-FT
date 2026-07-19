import { describe, it, expect } from "vitest";
import { resolvePreselectPatch } from "./package-preselect";

// 2026-07-01 = Wednesday (weekday), 2026-07-04 = Saturday (weekend).
const WEEKDAY = "2026-07-01";
const WEEKEND = "2026-07-04";
const FAMILY = "ultimate-qualifier";

const adult = (over: object = {}) => ({ isNewRacer: true, category: "adult" as const, ...over });
const junior = (over: object = {}) => ({ isNewRacer: true, category: "junior" as const, ...over });
const empty = { packageIdAdult: null, packageIdJunior: null };

describe("resolvePreselectPatch — Experiences-tile package preselect", () => {
  it("uniform all-new adult party stamps the adult variant only", () => {
    const patch = resolvePreselectPatch({
      party: [adult(), adult()],
      date: WEEKDAY,
      preferredFamily: FAMILY,
      current: empty,
    });
    expect(patch).toEqual({ packageIdAdult: "ultimate-qualifier-weekday" });
  });

  it("MIXED all-new party stamps BOTH variants (skips both product steps)", () => {
    const patch = resolvePreselectPatch({
      party: [adult(), junior()],
      date: WEEKDAY,
      preferredFamily: FAMILY,
      current: empty,
    });
    expect(patch).toEqual({
      packageIdAdult: "ultimate-qualifier-weekday",
      packageIdJunior: "ultimate-qualifier-weekday-junior",
    });
  });

  it("weekend dates resolve the weekend variants", () => {
    const patch = resolvePreselectPatch({
      party: [adult(), junior()],
      date: WEEKEND,
      preferredFamily: FAMILY,
      current: empty,
    });
    expect(patch).toEqual({
      packageIdAdult: "ultimate-qualifier-weekend",
      packageIdJunior: "ultimate-qualifier-weekend-junior",
    });
  });

  it("a returning racer anywhere in the party blocks preselect (packages are new-racer-only)", () => {
    expect(
      resolvePreselectPatch({
        party: [adult(), junior({ isNewRacer: false })],
        date: WEEKDAY,
        preferredFamily: FAMILY,
        current: empty,
      }),
    ).toBeNull();
  });

  it("empty party waits (null — the effect re-runs after the party step)", () => {
    expect(
      resolvePreselectPatch({
        party: [],
        date: WEEKDAY,
        preferredFamily: FAMILY,
        current: empty,
      }),
    ).toBeNull();
  });

  it("already-stamped categories are skipped — a fully-stamped item returns null (no re-dispatch loop)", () => {
    expect(
      resolvePreselectPatch({
        party: [adult(), junior()],
        date: WEEKDAY,
        preferredFamily: FAMILY,
        current: {
          packageIdAdult: "ultimate-qualifier-weekday",
          packageIdJunior: "ultimate-qualifier-weekday-junior",
        },
      }),
    ).toBeNull();
  });

  it("stamps only the missing category when the other is already set", () => {
    const patch = resolvePreselectPatch({
      party: [adult(), junior()],
      date: WEEKDAY,
      preferredFamily: FAMILY,
      current: { packageIdAdult: "ultimate-qualifier-weekday", packageIdJunior: null },
    });
    expect(patch).toEqual({ packageIdJunior: "ultimate-qualifier-weekday-junior" });
  });

  it("unknown family resolves nothing", () => {
    expect(
      resolvePreselectPatch({
        party: [adult()],
        date: WEEKDAY,
        preferredFamily: "no-such-family",
        current: empty,
      }),
    ).toBeNull();
  });
});
