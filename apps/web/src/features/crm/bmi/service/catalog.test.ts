import { describe, expect, it } from "vitest";
import { CATALOG_LIMIT, rankCatalog, scoreProductName } from "./catalog";

/**
 * Catalogue ranking — pure, so the order a rep sees is a unit test rather than
 * "whatever the metadata blob happened to list first".
 */

const CATALOG: Record<string, string> = {
  "1": "Pizza",
  "2": "Deep Dish Pizza",
  "3": "Party Pizza Add-on",
  "4": "Extra Pepperoni",
  "5": "Bowling Lane (2 hours)",
};

describe("scoreProductName", () => {
  it("prefix beats word-start beats substring", () => {
    expect(scoreProductName("Pizza", "piz")).toBe(3);
    expect(scoreProductName("Deep Dish Pizza", "piz")).toBe(2);
    expect(scoreProductName("Extra Pepperoni", "pepp")).toBe(2);
    expect(scoreProductName("Bowling Lane (2 hours)", "owl")).toBe(1);
    expect(scoreProductName("Pizza", "lane")).toBe(-1);
  });

  it("is case-insensitive and treats an empty query as neutral", () => {
    expect(scoreProductName("PIZZA", "pizza")).toBe(3);
    expect(scoreProductName("anything", "")).toBe(0);
  });

  it("does not choke on regex metacharacters a rep can type", () => {
    expect(() => scoreProductName("Bowling Lane (2 hours)", "(2")).not.toThrow();
    expect(scoreProductName("Bowling Lane (2 hours)", "(2")).toBeGreaterThanOrEqual(1);
    expect(scoreProductName("Pizza", "*")).toBe(-1);
  });
});

describe("rankCatalog", () => {
  it("puts the exact prefix first, then word starts, then the rest", () => {
    expect(rankCatalog(CATALOG, "piz").map((p) => p.name)).toEqual([
      "Pizza",
      "Deep Dish Pizza",
      "Party Pizza Add-on",
    ]);
  });

  it("drops non-matches entirely rather than ranking them last", () => {
    const names = rankCatalog(CATALOG, "piz").map((p) => p.name);
    expect(names).not.toContain("Bowling Lane (2 hours)");
    expect(names).not.toContain("Extra Pepperoni");
  });

  it("lists everything alphabetically when nothing is typed", () => {
    expect(rankCatalog(CATALOG, "").map((p) => p.name)).toEqual([
      "Bowling Lane (2 hours)",
      "Deep Dish Pizza",
      "Extra Pepperoni",
      "Party Pizza Add-on",
      "Pizza",
    ]);
  });

  it("NEVER carries a price on a list read", () => {
    // One Office round trip per product, and the answer depends on the date —
    // so a priced list would be both expensive and wrong.
    expect(rankCatalog(CATALOG, "").every((p) => p.priceCents === null)).toBe(true);
  });

  it("caps a fat catalogue so the picker cannot be wedged", () => {
    const huge = Object.fromEntries(
      Array.from({ length: 900 }, (_, i) => [String(i), `Product ${i}`]),
    );
    expect(rankCatalog(huge, "")).toHaveLength(CATALOG_LIMIT);
    expect(rankCatalog(huge, "", 5)).toHaveLength(5);
  });

  it("keeps the product id as a STRING", () => {
    const [first] = rankCatalog({ "63000000009561437": "Big id product" }, "");
    expect(first.productId).toBe("63000000009561437");
    expect(typeof first.productId).toBe("string");
  });
});
