import { describe, expect, it } from "vitest";
import {
  allGroups,
  buildFoodRawItems,
  configurableFoodItems,
  extraCentsForLane,
  extraCentsTotal,
  extraPicksForLane,
  foodSelectionIssue,
  toggleSelection,
  type FoodItem,
  type LaneSelections,
} from "./food-config";

// Real ids — these are the live Pizza Bowl catalog objects, so the equivalence
// test below is checking against the actual shipped output.
const PIZZA = "2IKZB4O2HQBXWMTSUQ2SEKJY";
const SODA = "SJUBJLB4QGHIHCW5AKTTMLH7";

const TOPPINGS = {
  id: "grp_top",
  name: "Pizza Toppings",
  selectionType: "MULTIPLE" as const,
  options: [
    { id: "o_pep", name: "Pepperoni" },
    { id: "o_sau", name: "Sausage" },
    { id: "o_mush", name: "Mushroom" },
  ],
};
const SODA_CHOICE = {
  id: "grp_soda",
  name: "Soda Choice",
  selectionType: "SINGLE" as const,
  options: [
    { id: "o_coke", name: "Coke" },
    { id: "o_sprite", name: "Sprite" },
  ],
};

/** The Pizza Bowl package as config: 1 topping free, $1 each extra. */
const PIZZA_BOWL: FoodItem[] = [
  {
    catalogObjectId: PIZZA,
    name: "Pizza Bowl Pizza",
    includedModifierCount: 1,
    extraModifierCents: 100,
    groups: [TOPPINGS],
  },
  {
    catalogObjectId: SODA,
    name: "Pizza Bowl Soda Pitcher",
    includedModifierCount: 1,
    extraModifierCents: 0,
    groups: [SODA_CHOICE],
  },
];

/** NFL game day: wings carry TWO single-choice groups on one item. */
const WING_HEAT = {
  id: "grp_heat",
  name: "Wing Heat",
  selectionType: "SINGLE" as const,
  options: [
    { id: "o_mild", name: "Mild" },
    { id: "o_med", name: "Medium" },
    { id: "o_hot", name: "Hot" },
  ],
};
const DRESSING = {
  id: "grp_dress",
  name: "Dressing",
  selectionType: "SINGLE" as const,
  options: [
    { id: "o_ranch", name: "Ranch" },
    { id: "o_blue", name: "Blue Cheese" },
  ],
};
const NFL: FoodItem[] = [
  {
    catalogObjectId: "CAT_NFL_PIZZA",
    name: "Game Day Pizza",
    includedModifierCount: 1,
    extraModifierCents: 100,
    groups: [TOPPINGS],
  },
  {
    catalogObjectId: "CAT_NFL_WINGS",
    name: "Game Day Wings (10)",
    includedModifierCount: 1,
    extraModifierCents: 0,
    groups: [WING_HEAT, DRESSING],
  },
  {
    catalogObjectId: "CAT_NFL_SODA",
    name: "Game Day Soda Pitcher",
    includedModifierCount: 1,
    extraModifierCents: 0,
    groups: [SODA_CHOICE],
  },
];

describe("configurableFoodItems", () => {
  it("picks the $0 bundled items and leaves the priced lane item alone", () => {
    const items = [
      { priceCents: 11995, squareCatalogObjectId: "CAT_LANE" },
      { priceCents: 0, squareCatalogObjectId: PIZZA },
      { priceCents: 0, squareCatalogObjectId: SODA },
      { priceCents: 500, squareCatalogObjectId: "CAT_SHOES" },
    ];
    expect(configurableFoodItems(items).map((i) => i.squareCatalogObjectId)).toEqual([PIZZA, SODA]);
  });

  it("skips a $0 row with no catalog object — nothing to attach modifiers to", () => {
    expect(configurableFoodItems([{ priceCents: 0, squareCatalogObjectId: "" }])).toEqual([]);
  });

  it("treats null and undefined as empty", () => {
    expect(configurableFoodItems(null)).toEqual([]);
    expect(configurableFoodItems(undefined)).toEqual([]);
  });
});

describe("toggleSelection", () => {
  it("SINGLE replaces the previous pick", () => {
    let sel: LaneSelections[] = [{}];
    sel = toggleSelection({
      selections: sel,
      laneIndex: 0,
      groupId: "grp_soda",
      optionId: "o_coke",
      selectionType: "SINGLE",
    });
    sel = toggleSelection({
      selections: sel,
      laneIndex: 0,
      groupId: "grp_soda",
      optionId: "o_sprite",
      selectionType: "SINGLE",
    });
    expect(sel[0].grp_soda).toEqual(["o_sprite"]);
  });

  it("SINGLE tapped twice clears it", () => {
    let sel: LaneSelections[] = [{}];
    for (let i = 0; i < 2; i++) {
      sel = toggleSelection({
        selections: sel,
        laneIndex: 0,
        groupId: "grp_soda",
        optionId: "o_coke",
        selectionType: "SINGLE",
      });
    }
    expect(sel[0].grp_soda).toEqual([]);
  });

  it("MULTIPLE accumulates and un-toggles", () => {
    let sel: LaneSelections[] = [{}];
    for (const o of ["o_pep", "o_sau"]) {
      sel = toggleSelection({
        selections: sel,
        laneIndex: 0,
        groupId: "grp_top",
        optionId: o,
        selectionType: "MULTIPLE",
      });
    }
    expect(sel[0].grp_top).toEqual(["o_pep", "o_sau"]);
    sel = toggleSelection({
      selections: sel,
      laneIndex: 0,
      groupId: "grp_top",
      optionId: "o_pep",
      selectionType: "MULTIPLE",
    });
    expect(sel[0].grp_top).toEqual(["o_sau"]);
  });

  it("never mutates the input, and lanes stay independent", () => {
    const before: LaneSelections[] = [{ grp_top: ["o_pep"] }, {}];
    const after = toggleSelection({
      selections: before,
      laneIndex: 1,
      groupId: "grp_top",
      optionId: "o_sau",
      selectionType: "MULTIPLE",
    });
    expect(before[1]).toEqual({});
    expect(after).not.toBe(before);
    expect(after[0].grp_top).toEqual(["o_pep"]);
    expect(after[1].grp_top).toEqual(["o_sau"]);
  });

  it("fills a lane that has no entry yet", () => {
    const after = toggleSelection({
      selections: [],
      laneIndex: 2,
      groupId: "grp_soda",
      optionId: "o_coke",
      selectionType: "SINGLE",
    });
    expect(after[2].grp_soda).toEqual(["o_coke"]);
  });
});

describe("buildFoodRawItems — Pizza Bowl equivalence", () => {
  it("single lane matches the shipped shape exactly", () => {
    const sel: LaneSelections[] = [{ grp_top: ["o_pep"], grp_soda: ["o_coke"] }];
    expect(buildFoodRawItems({ foodItems: PIZZA_BOWL, selections: sel, laneCount: 1 })).toEqual([
      { catalogObjectId: PIZZA, name: "Pizza Bowl Pizza", quantity: 1, note: "Pepperoni" },
      { catalogObjectId: SODA, name: "Pizza Bowl Soda Pitcher", quantity: 1, note: "Coke" },
    ]);
  });

  it("multi-lane prefixes each lane, keeping choices distinct", () => {
    const sel: LaneSelections[] = [
      { grp_top: ["o_pep"], grp_soda: ["o_coke"] },
      { grp_top: ["o_sau"], grp_soda: ["o_sprite"] },
    ];
    const out = buildFoodRawItems({ foodItems: PIZZA_BOWL, selections: sel, laneCount: 2 });
    expect(out.map((r) => r.note)).toEqual([
      "Lane 1: Pepperoni",
      "Lane 1: Coke",
      "Lane 2: Sausage",
      "Lane 2: Sprite",
    ]);
  });

  it("joins several picks in the group's own option order, not tap order", () => {
    const sel: LaneSelections[] = [{ grp_top: ["o_mush", "o_pep"], grp_soda: ["o_coke"] }];
    const out = buildFoodRawItems({ foodItems: PIZZA_BOWL, selections: sel, laneCount: 1 });
    expect(out[0].note).toBe("Pepperoni, Mushroom");
  });

  it("omits the note entirely when a lane picked nothing", () => {
    const out = buildFoodRawItems({ foodItems: PIZZA_BOWL, selections: [{}], laneCount: 1 });
    expect(out).toEqual([
      { catalogObjectId: PIZZA, name: "Pizza Bowl Pizza", quantity: 1 },
      { catalogObjectId: SODA, name: "Pizza Bowl Soda Pitcher", quantity: 1 },
    ]);
  });

  it("emits one line per food item per lane", () => {
    const out = buildFoodRawItems({ foodItems: NFL, selections: [{}, {}, {}], laneCount: 3 });
    expect(out).toHaveLength(9);
  });
});

describe("buildFoodRawItems — grouping by item is the point", () => {
  it("wing heat and dressing land on the WINGS line, not smeared across all three", () => {
    const sel: LaneSelections[] = [
      { grp_top: ["o_pep"], grp_heat: ["o_mild"], grp_dress: ["o_ranch"], grp_soda: ["o_coke"] },
    ];
    const out = buildFoodRawItems({ foodItems: NFL, selections: sel, laneCount: 1 });
    expect(out).toEqual([
      { catalogObjectId: "CAT_NFL_PIZZA", name: "Game Day Pizza", quantity: 1, note: "Pepperoni" },
      {
        catalogObjectId: "CAT_NFL_WINGS",
        name: "Game Day Wings (10)",
        quantity: 1,
        note: "Mild, Ranch",
      },
      {
        catalogObjectId: "CAT_NFL_SODA",
        name: "Game Day Soda Pitcher",
        quantity: 1,
        note: "Coke",
      },
    ]);
  });
});

describe("extras charging", () => {
  it("one topping is free, the second costs a dollar", () => {
    expect(extraCentsForLane(PIZZA_BOWL, { grp_top: ["o_pep"] })).toBe(0);
    expect(extraCentsForLane(PIZZA_BOWL, { grp_top: ["o_pep", "o_sau"] })).toBe(100);
    expect(extraCentsForLane(PIZZA_BOWL, { grp_top: ["o_pep", "o_sau", "o_mush"] })).toBe(200);
  });

  it("counts extras per group, so an unused group grants no free pick elsewhere", () => {
    // Two picks on heat (impossible via SINGLE, but the maths must hold) and
    // none on dressing must still read as ONE extra — pooling would call it free.
    const wings = NFL[1];
    expect(extraPicksForLane(wings, { grp_heat: ["o_mild", "o_hot"], grp_dress: [] })).toBe(1);
  });

  it("an item with extraModifierCents 0 never charges", () => {
    expect(extraCentsForLane(PIZZA_BOWL, { grp_soda: ["o_coke", "o_sprite"] })).toBe(0);
  });

  it("totals across lanes", () => {
    const sel: LaneSelections[] = [
      { grp_top: ["o_pep", "o_sau"] },
      { grp_top: ["o_pep"] },
      { grp_top: ["o_pep", "o_sau", "o_mush"] },
    ];
    expect(extraCentsTotal({ foodItems: PIZZA_BOWL, selections: sel, laneCount: 3 })).toBe(300);
  });
});

describe("foodSelectionIssue", () => {
  const required = ["grp_top", "grp_soda"];

  it("passes when every group has a pick", () => {
    expect(
      foodSelectionIssue({
        requiredGroupIds: required,
        selections: [{ grp_top: ["o_pep"], grp_soda: ["o_coke"] }],
        laneCount: 1,
      }),
    ).toBeNull();
  });

  it("blocks on a missing drink", () => {
    expect(
      foodSelectionIssue({
        requiredGroupIds: required,
        selections: [{ grp_top: ["o_pep"] }],
        laneCount: 1,
      }),
    ).toBe("Pick an option in every group");
  });

  it("blocks when only the FIRST lane is complete, and says so", () => {
    expect(
      foodSelectionIssue({
        requiredGroupIds: required,
        selections: [{ grp_top: ["o_pep"], grp_soda: ["o_coke"] }, {}],
        laneCount: 2,
      }),
    ).toBe("Pick an option in every group, for every lane");
  });

  it("fails OPEN when nothing loaded — a Square hiccup must not trap a booking", () => {
    expect(foodSelectionIssue({ requiredGroupIds: [], selections: [], laneCount: 2 })).toBeNull();
  });

  it("treats an empty selections array as incomplete, not complete", () => {
    expect(
      foodSelectionIssue({ requiredGroupIds: required, selections: [], laneCount: 1 }),
    ).not.toBeNull();
  });
});

describe("allGroups", () => {
  it("flattens in item then group order", () => {
    expect(allGroups(NFL).map((g) => g.id)).toEqual([
      "grp_top",
      "grp_heat",
      "grp_dress",
      "grp_soda",
    ]);
  });
});
