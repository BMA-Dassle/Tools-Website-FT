import { describe, expect, it } from "vitest";
import type { FoodItem } from "~/features/booking/service/food-config";
import {
  extrasCentsFromLines,
  isFoodLine,
  parseFoodLineLabel,
  rawItemsFromStoredLines,
  selectionsFromStoredLines,
} from "./lines";

const PIZZA = "2IKZB4O2HQBXWMTSUQ2SEKJY";
const SODA = "SJUBJLB4QGHIHCW5AKTTMLH7";

// The REAL Pizza Bowl shape: two topping lists sharing names, one drink list.
const INCLUDED = {
  id: "g_incl",
  name: "One included Topping",
  selectionType: "SINGLE" as const,
  options: [
    { id: "i_none", name: "No Topping" },
    { id: "i_pep", name: "Pepperoni" },
    { id: "i_bacon", name: "Bacon" },
  ],
};
const PAID = {
  id: "g_paid",
  name: "Pizza Toppings",
  selectionType: "MULTIPLE" as const,
  options: [
    { id: "p_pep", name: "Pepperoni", priceCents: 200 },
    { id: "p_bacon", name: "Bacon", priceCents: 200 },
    { id: "p_onion", name: "Onions", priceCents: 100 },
  ],
};
const DRINK = {
  id: "g_soda",
  name: "Soda Choice",
  selectionType: "SINGLE" as const,
  options: [
    { id: "s_pepsi", name: "Pepsi" },
    { id: "s_starry", name: "Starry" },
  ],
};
const FOOD: FoodItem[] = [
  {
    catalogObjectId: PIZZA,
    name: "Pizza Bowl Pizza",
    includedModifierCount: 1,
    extraModifierCents: 0,
    groups: [INCLUDED, PAID],
  },
  {
    catalogObjectId: SODA,
    name: "Pizza Bowl Soda Pitcher",
    includedModifierCount: 1,
    extraModifierCents: 0,
    groups: [DRINK],
  },
];
const ITEMS = FOOD.map((f) => ({ label: f.name, squareCatalogObjectId: f.catalogObjectId }));

describe("parseFoodLineLabel", () => {
  const labels = ["Pizza Bowl Pizza", "Pizza Bowl Soda Pitcher"];

  it("reads a one-lane line", () => {
    expect(parseFoodLineLabel("Pizza Bowl Pizza — Bacon", labels)).toEqual({
      itemLabel: "Pizza Bowl Pizza",
      laneIndex: null,
      picks: ["Bacon"],
      note: "Bacon",
    });
  });

  it("reads the lane prefix and several picks", () => {
    expect(parseFoodLineLabel("Pizza Bowl Pizza — Lane 2: Bacon, Pepperoni", labels)).toEqual({
      itemLabel: "Pizza Bowl Pizza",
      laneIndex: 1,
      picks: ["Bacon", "Pepperoni"],
      note: "Lane 2: Bacon, Pepperoni",
    });
  });

  it("reads a bare item label as a line with no choice stored", () => {
    expect(parseFoodLineLabel("Pizza Bowl Pizza", labels)).toEqual({
      itemLabel: "Pizza Bowl Pizza",
      laneIndex: null,
      picks: [],
      note: "",
    });
  });

  it("ignores the lane item and shoes", () => {
    expect(parseFoodLineLabel("Pizza Bowl - Regular", labels)).toBeNull();
    expect(parseFoodLineLabel("Shoe Rental", labels)).toBeNull();
  });

  it("prefers the longest matching label", () => {
    expect(
      parseFoodLineLabel("Pizza Bowl Pizza Deluxe — Ham", [
        "Pizza Bowl Pizza",
        "Pizza Bowl Pizza Deluxe",
      ])?.itemLabel,
    ).toBe("Pizza Bowl Pizza Deluxe");
  });
});

describe("isFoodLine / extrasCentsFromLines", () => {
  it("recognises the food rows and BOTH extras spellings", () => {
    const labels = ["Pizza Bowl Pizza"];
    expect(isFoodLine("Pizza Bowl Pizza — Bacon", labels)).toBe(true);
    expect(isFoodLine("Extra Pizza Topping", labels)).toBe(true);
    expect(isFoodLine("Food extras", labels)).toBe(true);
    expect(isFoodLine("Pizza Bowl - Regular", labels)).toBe(false);
  });

  it("sums legacy $1 topping rows and the new extras row alike", () => {
    expect(
      extrasCentsFromLines([
        { name: "Extra Pizza Topping", quantity: "2", unitCents: 100 },
        { name: "Food extras", quantity: 1, unitCents: 300 },
        { name: "Pizza Bowl Pizza", quantity: 1, unitCents: 0 },
      ]),
    ).toBe(500);
  });
});

describe("rawItemsFromStoredLines — the catalog-free gate input", () => {
  it("rebuilds one noted line per stored food row", () => {
    expect(
      rawItemsFromStoredLines(ITEMS, [
        { label: "Pizza Bowl - Regular", quantity: 1 },
        { label: "Pizza Bowl Pizza — Bacon", quantity: 1 },
        { label: "Pizza Bowl Soda Pitcher — Starry", quantity: 1 },
      ]),
    ).toEqual([
      { catalogObjectId: PIZZA, name: "Pizza Bowl Pizza", note: "Bacon" },
      { catalogObjectId: SODA, name: "Pizza Bowl Soda Pitcher", note: "Starry" },
    ]);
  });

  it("yields NOTHING for the 9/6 shape (lane item only) — so the gate refuses", () => {
    expect(
      rawItemsFromStoredLines(ITEMS, [{ label: "Pizza Bowl - Regular", quantity: 2 }]),
    ).toEqual([]);
  });

  it("expands a quantity and leaves an unnoted row without a note", () => {
    expect(rawItemsFromStoredLines(ITEMS, [{ label: "Pizza Bowl Pizza", quantity: 2 }])).toEqual([
      { catalogObjectId: PIZZA, name: "Pizza Bowl Pizza" },
      { catalogObjectId: PIZZA, name: "Pizza Bowl Pizza" },
    ]);
  });
});

describe("selectionsFromStoredLines — prefill", () => {
  it("prefills a one-lane booking, included pick first", () => {
    const sel = selectionsFromStoredLines({
      foodItems: FOOD,
      lines: [
        { label: "Pizza Bowl - Regular", quantity: 1 },
        { label: "Pizza Bowl Pizza — Pepperoni", quantity: 1 },
        { label: "Pizza Bowl Soda Pitcher — Starry", quantity: 1 },
      ],
      laneCount: 1,
    });
    expect(sel).toEqual([{ g_incl: ["i_pep"], g_soda: ["s_starry"] }]);
  });

  it("puts a second topping on the PAID list once the included pick is taken", () => {
    const sel = selectionsFromStoredLines({
      foodItems: FOOD,
      lines: [{ label: "Pizza Bowl Pizza — Pepperoni, Bacon", quantity: 1 }],
      laneCount: 1,
    });
    expect(sel[0]).toEqual({ g_incl: ["i_pep"], g_paid: ["p_bacon"] });
  });

  it("routes lane-prefixed lines to their lane and matches names case-insensitively", () => {
    const sel = selectionsFromStoredLines({
      foodItems: FOOD,
      lines: [
        { label: "Pizza Bowl Pizza — Lane 1: bacon", quantity: 1 },
        { label: "Pizza Bowl Soda Pitcher — Lane 1: Pepsi", quantity: 1 },
        { label: "Pizza Bowl Pizza — Lane 2: No Topping", quantity: 1 },
        { label: "Pizza Bowl Soda Pitcher — Lane 2: Starry", quantity: 1 },
      ],
      laneCount: 2,
    });
    expect(sel).toEqual([
      { g_incl: ["i_bacon"], g_soda: ["s_pepsi"] },
      { g_incl: ["i_none"], g_soda: ["s_starry"] },
    ]);
  });

  it("drops a name the catalog no longer carries instead of guessing", () => {
    const sel = selectionsFromStoredLines({
      foodItems: FOOD,
      lines: [{ label: "Pizza Bowl Soda Pitcher — Mello Yello", quantity: 1 }],
      laneCount: 1,
    });
    expect(sel).toEqual([{}]);
  });

  it("returns empty lanes for a booking with no food rows", () => {
    expect(
      selectionsFromStoredLines({
        foodItems: FOOD,
        lines: [{ label: "Pizza Bowl - Regular", quantity: 2 }],
        laneCount: 2,
      }),
    ).toEqual([{}, {}]);
  });
});
