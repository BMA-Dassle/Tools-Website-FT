import { describe, expect, it } from "vitest";
import { lookupCatalogId, lookupCatalogIdByName, SQUARE_CATALOG_IDS } from "./square-catalog-map";
import { _allRaceProducts, combineTrackVariants } from "../service/race-products";

describe("lookupCatalogId", () => {
  it("resolves a plain mapped BMI product id", () => {
    // Starter Red weekday new -> Karting
    expect(lookupCatalogId("24960859")).toBe(SQUARE_CATALOG_IDS.KARTING);
  });

  it("returns null for an unmapped id", () => {
    expect(lookupCatalogId("00000000")).toBeNull();
  });

  it("maps the standalone POV product id (was ad-hoc, broke QBO categorization)", () => {
    expect(lookupCatalogId("43746981")).toBe(SQUARE_CATALOG_IDS.POV);
  });

  describe("combined-track single-race card (synthetic `m:` id)", () => {
    it("resolves via a component track id to the shared Karting item", () => {
      // combineTrackVariants() builds `m:<sorted ids>`; both adult tracks of a
      // tier map to Karting, so any present component resolves it.
      expect(lookupCatalogId("m:24960393:24960859")).toBe(SQUARE_CATALOG_IDS.KARTING);
    });

    it("resolves when only the second component is mapped", () => {
      expect(lookupCatalogId("m:99999999:24960859")).toBe(SQUARE_CATALOG_IDS.KARTING);
    });

    it("resolves a junior combined id to the junior item, not adult Karting", () => {
      // Junior Mon-Thu product -> JR_MON_THU. Confirms component-based resolution
      // never mis-buckets juniors into adult Karting.
      expect(lookupCatalogId("m:24960106:99999999")).toBe(SQUARE_CATALOG_IDS.JR_MON_THU);
    });

    it("returns null when no component is mapped", () => {
      expect(lookupCatalogId("m:11111111:22222222")).toBeNull();
    });
  });
});

describe("lookupCatalogIdByName", () => {
  it("matches the standalone POV video line by name", () => {
    expect(lookupCatalogIdByName("POV Race Video")).toBe(SQUARE_CATALOG_IDS.POV);
  });

  it("matches Ultimate Qualifier including a discount suffix (substring)", () => {
    expect(lookupCatalogIdByName("Ultimate Qualifier (League Racer −20%)")).toBe(
      SQUARE_CATALOG_IDS.ULTIMATE_QUALIFIER,
    );
  });

  it("returns null for a bare combined race name (resolved by id, not name)", () => {
    // Intentional: "Starter Race" is NOT a NAME_CATALOG_MAP key — adding it would
    // mis-match "Junior Starter Race Blue" to adult Karting. The synthetic id path
    // in lookupCatalogId handles the combined card precisely instead.
    expect(lookupCatalogIdByName("Starter Race")).toBeNull();
  });
});

describe("integration: every real combined-track card resolves to a catalog id", () => {
  // Regression guard for the QBO categorization bug: combineTrackVariants() emits
  // synthetic `m:` ids that must all resolve, else the card books ad-hoc with no
  // Square category and surfaces as a loose item in the QBO journal sync.
  const combined = combineTrackVariants([..._allRaceProducts()]).filter((p) =>
    String(p.productId).startsWith("m:"),
  );

  it("produces at least one combined card", () => {
    expect(combined.length).toBeGreaterThan(0);
  });

  it.each(combined.map((p) => [p.name, p.productId] as const))(
    "%s (%s) resolves to a catalog id",
    (_name, productId) => {
      expect(lookupCatalogId(productId)).toBeTruthy();
    },
  );
});
