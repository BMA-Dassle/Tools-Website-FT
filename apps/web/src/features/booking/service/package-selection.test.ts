import { describe, expect, it } from "vitest";
import { clearPackageForCategory } from "./package-selection";
import { getPackage } from "./packages";
import type { RaceHeatAssignment } from "../state/types";

// The adult weekday Rookie Pack's own race component (Starter Red) and the
// junior weekday variant's — read from the registry so a catalog edit can't
// quietly make this test lie.
const adultPkg = getPackage("rookie-pack-weekday")!;
const juniorPkg = getPackage("rookie-pack-weekday-junior")!;
const adultPackProductId = adultPkg.races[0].tracks[0].productId;
const juniorPackProductId = juniorPkg.races[0].tracks[0].productId;

const heat = (over: Partial<RaceHeatAssignment>): RaceHeatAssignment => ({
  productId: adultPackProductId,
  track: "Red",
  heatId: "h1",
  bmiLineId: null,
  assignedTo: "m1",
  ...over,
});

const item = (over: Partial<Parameters<typeof clearPackageForCategory>[0]> = {}) => ({
  packageIdAdult: null as string | null,
  packageIdJunior: null as string | null,
  heats: [] as RaceHeatAssignment[],
  ...over,
});

describe("clearPackageForCategory", () => {
  it("nulls the category's package id and hands back its held heats", () => {
    const packHeat = heat({ heatId: "h1", bmiLineId: "L1" });
    const { patch, removed } = clearPackageForCategory(
      item({ packageIdAdult: adultPkg.id, heats: [packHeat] }),
      "adult",
    );
    expect(patch.packageIdAdult).toBeNull();
    expect(removed).toEqual([packHeat]);
    expect(patch.heats).toEqual([]);
  });

  it("keeps single races the guest added alongside the package", () => {
    const packHeat = heat({ heatId: "h1" });
    const single = heat({ heatId: "h2", productId: "43046468" });
    const { patch, removed } = clearPackageForCategory(
      item({ packageIdAdult: adultPkg.id, heats: [packHeat, single] }),
      "adult",
    );
    expect(removed).toEqual([packHeat]);
    expect(patch.heats).toEqual([single]);
  });

  it("touches ONE category only — the junior pack survives an adult removal", () => {
    const adultHeat = heat({ heatId: "h1" });
    const juniorHeat = heat({
      heatId: "h2",
      productId: juniorPackProductId,
      category: "junior",
      assignedTo: "m2",
    });
    const { patch, removed } = clearPackageForCategory(
      item({
        packageIdAdult: adultPkg.id,
        packageIdJunior: juniorPkg.id,
        heats: [adultHeat, juniorHeat],
      }),
      "adult",
    );
    expect(patch.packageIdAdult).toBeNull();
    expect(patch.packageIdJunior).toBeUndefined(); // untouched, not cleared
    expect(removed).toEqual([adultHeat]);
    expect(patch.heats).toEqual([juniorHeat]);
  });

  it("is idempotent with no package selected (nothing to release)", () => {
    const single = heat({ productId: "43046468" });
    const { patch, removed } = clearPackageForCategory(item({ heats: [single] }), "adult");
    expect(patch).toEqual({ packageIdAdult: null });
    expect(removed).toEqual([]);
  });

  it("never drops an unbooked (heatId-less) placeholder row", () => {
    const placeholder = heat({ heatId: null });
    const { patch, removed } = clearPackageForCategory(
      item({ packageIdAdult: adultPkg.id, heats: [placeholder] }),
      "adult",
    );
    expect(removed).toEqual([]);
    expect(patch.heats).toBeUndefined();
  });
});
