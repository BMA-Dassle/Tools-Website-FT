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
  // The ORDER is the contract, not the numbers — those were rescaled when
  // token matching was added and a test pinned to literals would have failed
  // for a change that altered no behaviour anyone can see.
  it("prefix beats word-start beats substring", () => {
    const prefix = scoreProductName("Pizza", "piz");
    const wordStart = scoreProductName("Deep Dish Pizza", "piz");
    const substring = scoreProductName("Bowling Lane (2 hours)", "owl");
    expect(prefix).toBeGreaterThan(wordStart);
    expect(wordStart).toBeGreaterThan(substring);
    expect(substring).toBeGreaterThan(0);
    expect(scoreProductName("Extra Pepperoni", "pepp")).toBe(wordStart);
    expect(scoreProductName("Pizza", "lane")).toBe(-1);
  });

  it("is case-insensitive and treats an empty query as neutral", () => {
    expect(scoreProductName("PIZZA", "pizza")).toBe(scoreProductName("Pizza", "piz"));
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

describe("the picker finds what Office finds", () => {
  /**
   * Owner, 2026-09-14: "missing products that BMI office has". Searching
   * "GF Start" in the builder returned nothing while Office's own product list
   * returned six — because the ranker required the whole query as one
   * contiguous substring, and "GF Race Blue Starter Mon-Thur" does not contain
   * "gf start".
   */
  const KARTING: Record<string, string> = {
    "1": "GF Race Blue Starter Mon-Thur",
    "2": "GF Race Blue Starter Fri-Sun",
    "3": "GF Race Red Starter Mon-Thur",
    "4": "GF Race Red Starter Fri-Sun",
    "5": "GF Race Mega Starter",
    "6": "GF Duckpin Buyout",
  };

  it('"GF Start" finds every starter, the way Office does', () => {
    const names = rankCatalog(KARTING, "GF Start").map((p) => p.name);
    expect(names).toHaveLength(5);
    expect(names).toContain("GF Race Blue Starter Mon-Thur");
    expect(names).toContain("GF Race Mega Starter");
    // Still a filter, not a free-for-all: the Duckpin buyout has no "start".
    expect(names).not.toContain("GF Duckpin Buyout");
  });

  it("word order does not matter — a rep types what they remember", () => {
    expect(rankCatalog(KARTING, "starter blue").map((p) => p.name)).toEqual([
      "GF Race Blue Starter Fri-Sun",
      "GF Race Blue Starter Mon-Thur",
    ]);
  });

  it("a token that is nowhere in the name still rules it out", () => {
    expect(rankCatalog(KARTING, "GF Bowling")).toEqual([]);
    expect(scoreProductName("GF Race Mega Starter", "GF Bowling")).toBe(-1);
  });

  it("the tighter match still wins: a substring outranks scattered tokens", () => {
    const menu = { a: "Pizza", b: "Deep Dish Pizza", c: "Pepperoni and Sausage Pizza" };
    expect(rankCatalog(menu, "piz")[0]!.name).toBe("Pizza");
    // "deep pizza" matches b by tokens only; "deep dish" is a real substring.
    expect(scoreProductName("Deep Dish Pizza", "deep dish")).toBeGreaterThan(
      scoreProductName("Deep Dish Pizza", "deep pizza"),
    );
  });

  it("a single word that is not present is still no match", () => {
    expect(scoreProductName("GF Race Mega Starter", "bowling")).toBe(-1);
  });
});
