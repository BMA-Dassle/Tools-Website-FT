import { describe, expect, it } from "vitest";
import {
  allGroups,
  isRequired,
  optionCentsForLane,
  remainingPicks,
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

  it("pools the allowance across an item's groups — the REAL Pizza Bowl shape", () => {
    // Live catalog, 2026-08-31: the pizza carries TWO lists —
    //   "One included Topping" (SINGLE)  +  "Pizza Toppings" (MULTIPLE, paid)
    // which together express ONE free topping. Counting per group would give
    // each list its own free pick and undercharge by a dollar a lane.
    const realPizza: FoodItem = {
      catalogObjectId: PIZZA,
      name: "Pizza Bowl Pizza",
      includedModifierCount: 1,
      extraModifierCents: 100,
      groups: [
        {
          id: "grp_included",
          name: "One included Topping",
          selectionType: "SINGLE",
          options: [
            { id: "o_none", name: "No Topping" },
            { id: "o_pep", name: "Pepperoni" },
          ],
        },
        { ...TOPPINGS, id: "grp_extra", name: "Pizza Toppings" },
      ],
    };
    // 1 included, nothing extra → free.
    expect(extraPicksForLane(realPizza, { grp_included: ["o_pep"] })).toBe(0);
    // 1 included + 2 extras → TWO extras, $2. Per-group maths would say $1.
    expect(
      extraPicksForLane(realPizza, { grp_included: ["o_pep"], grp_extra: ["o_sau", "o_mush"] }),
    ).toBe(2);
    expect(
      extraCentsForLane([realPizza], { grp_included: ["o_pep"], grp_extra: ["o_sau", "o_mush"] }),
    ).toBe(200);
  });

  it("an item that charges nothing is unaffected by pooling", () => {
    // NFL wings carry heat + dressing, two genuinely independent choices —
    // pooled they read as one extra, but extraModifierCents is 0 so no charge.
    const wings = NFL[1];
    expect(extraPicksForLane(wings, { grp_heat: ["o_mild"], grp_dress: ["o_ranch"] })).toBe(1);
    expect(extraCentsForLane([wings], { grp_heat: ["o_mild"], grp_dress: ["o_ranch"] })).toBe(0);
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

/**
 * The real NFL wings, as the catalog script attaches them (live ids and prices,
 * read 2026-08-31). Three required lists, two optional and priced.
 */
const WING_SAUCE = {
  id: "J66H25NSLZDVOZW2QPZO4EYP",
  name: "Sauce Selection",
  selectionType: "MULTIPLE" as const,
  minSelected: 1,
  maxSelected: 2,
  options: [
    { id: "s_mild", name: "Mild", priceCents: 0 },
    { id: "s_hot", name: "Hot", priceCents: 0 },
  ],
};
const WING_DIP = {
  id: "AHWVRX4UFKBALXTKBPB7PMN5",
  name: "Dippers",
  selectionType: "MULTIPLE" as const,
  minSelected: 1,
  maxSelected: 1,
  options: [
    { id: "d_ranch", name: "Ranch", priceCents: 0 },
    { id: "d_blue", name: "Blue Cheese", priceCents: 0 },
  ],
};
const WING_BREADING = {
  id: "ERVWHF7QP6XWNPCN4OWPMUNH",
  name: "Breaded or Naked",
  selectionType: "MULTIPLE" as const,
  minSelected: 1,
  maxSelected: 1,
  options: [
    { id: "b_breaded", name: "Breaded", priceCents: 0 },
    { id: "b_naked", name: "Naked", priceCents: 0 },
  ],
};
const WING_CUT = {
  id: "TBXFTPA2KHIRG56CDSMGT3WJ",
  name: "~ Mixed, Drums or Flats",
  selectionType: "SINGLE" as const,
  minSelected: 0,
  maxSelected: 1,
  options: [
    { id: "c_mix", name: "Mix of Drums and Flats", priceCents: 0 },
    { id: "c_drums", name: "All Drums", priceCents: 200 },
  ],
};
const WING_EXTRA_SAUCE = {
  id: "CKL3GK33VONWE4X5D5GU54MO",
  name: "Sauce Extra-",
  selectionType: "MULTIPLE" as const,
  minSelected: 0,
  maxSelected: null,
  options: [
    { id: "x_bbq", name: "BBQ", priceCents: 75 },
    { id: "x_ranch", name: "Ranch", priceCents: 75 },
  ],
};
const GAME_DAY_WINGS: FoodItem = {
  catalogObjectId: "CAT_NFL_WINGS",
  name: "Game Day Wings (10)",
  includedModifierCount: 1,
  extraModifierCents: 0,
  groups: [WING_SAUCE, WING_DIP, WING_BREADING, WING_CUT, WING_EXTRA_SAUCE],
};

describe("required vs optional groups", () => {
  it("reads requiredness off the per-item minimum", () => {
    expect(isRequired(WING_SAUCE)).toBe(true);
    expect(isRequired(WING_BREADING)).toBe(true);
    expect(isRequired(WING_CUT)).toBe(false);
    expect(isRequired(WING_EXTRA_SAUCE)).toBe(false);
  });

  it("treats a missing minimum as OPTIONAL, not required", () => {
    // Square sends -1 for "unset"; the route normalises that to 0. Defaulting
    // the other way would trap a guest on a group they cannot satisfy.
    expect(isRequired({ ...WING_CUT, minSelected: undefined })).toBe(false);
  });

  it("lets the guest through with the three required answers and nothing else", () => {
    const required = [WING_SAUCE, WING_DIP, WING_BREADING].map((g) => g.id);
    expect(
      foodSelectionIssue({
        requiredGroupIds: required,
        selections: [
          {
            [WING_SAUCE.id]: ["s_mild"],
            [WING_DIP.id]: ["d_ranch"],
            [WING_BREADING.id]: ["b_breaded"],
          },
        ],
        laneCount: 1,
      }),
    ).toBeNull();
  });

  it("still blocks when a required group is unanswered", () => {
    expect(
      foodSelectionIssue({
        requiredGroupIds: [WING_SAUCE.id, WING_DIP.id, WING_BREADING.id],
        selections: [{ [WING_SAUCE.id]: ["s_mild"], [WING_DIP.id]: ["d_ranch"] }],
        laneCount: 1,
      }),
    ).not.toBeNull();
  });
});

describe("remainingPicks", () => {
  it("caps a MULTIPLE group at its max", () => {
    expect(remainingPicks(WING_SAUCE, 0)).toBe(2);
    expect(remainingPicks(WING_SAUCE, 2)).toBe(0);
    expect(remainingPicks(WING_DIP, 1)).toBe(0);
  });

  it("treats a null max as unlimited", () => {
    expect(remainingPicks(WING_EXTRA_SAUCE, 9)).toBeNull();
  });

  it("a SINGLE group always has room for the swap", () => {
    expect(remainingPicks(WING_CUT, 1)).toBe(0);
    expect(remainingPicks(WING_CUT, 0)).toBe(1);
  });
});

describe("option prices come from Square, not from our allowance rule", () => {
  it("charges nothing for the included answers", () => {
    const sel = {
      [WING_SAUCE.id]: ["s_mild"],
      [WING_DIP.id]: ["d_ranch"],
      [WING_BREADING.id]: ["b_breaded"],
    };
    expect(optionCentsForLane([GAME_DAY_WINGS], sel)).toBe(0);
    expect(extraCentsForLane([GAME_DAY_WINGS], sel)).toBe(0);
  });

  it("charges $2 for all-drums and 75c per extra sauce", () => {
    const sel = {
      [WING_SAUCE.id]: ["s_mild"],
      [WING_DIP.id]: ["d_ranch"],
      [WING_BREADING.id]: ["b_breaded"],
      [WING_CUT.id]: ["c_drums"],
      [WING_EXTRA_SAUCE.id]: ["x_bbq", "x_ranch"],
    };
    expect(optionCentsForLane([GAME_DAY_WINGS], sel)).toBe(200 + 75 + 75);
    expect(extraCentsForLane([GAME_DAY_WINGS], sel)).toBe(350);
  });

  it("free options in a priced group cost nothing", () => {
    expect(optionCentsForLane([GAME_DAY_WINGS], { [WING_CUT.id]: ["c_mix"] })).toBe(0);
  });

  it("sums BOTH pricing models — our allowance AND Square's option prices", () => {
    // The pizza's $1-per-extra-topping is our rule (Square lists those at $0);
    // the wings' +$2 is Square's. A booking with both must pay both.
    const pizza: FoodItem = {
      ...PIZZA_BOWL[0],
      groups: [{ ...TOPPINGS, id: "grp_top" }],
    };
    const sel = { grp_top: ["o_pep", "o_sau"], [WING_CUT.id]: ["c_drums"] };
    expect(extraCentsForLane([pizza, GAME_DAY_WINGS], sel)).toBe(100 + 200);
  });
});
