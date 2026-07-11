import { describe, expect, it } from "vitest";

import { getComboSpecial, comboPriceCentsForDate } from "~/features/combos/combo-specials";

import {
  repriceBowling,
  repriceComboRacers,
  repriceKbfExtras,
  repriceRaceDelta,
  resolveBookedPricing,
} from "./reprice";
import { EditGuardError, type HeatMeta, type ProductFacts, type StoredLine } from "./types";

const code = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    if (e instanceof EditGuardError) return e.code;
    throw e;
  }
  throw new Error("expected EditGuardError");
};

const line = (over: Partial<StoredLine>): StoredLine => ({
  squareProductId: 1,
  label: "Fun 4 All",
  quantity: 2,
  unitPriceCents: 1999,
  productKind: "open",
  catalogPriceCents: 1999,
  squareCatalogObjectId: "CAT_OPEN",
  ...over,
});

const SHOES: ProductFacts = {
  squareProductId: 7,
  label: "Shoe Rental",
  priceCents: 500,
  squareCatalogObjectId: "CAT_SHOE",
  productKind: "addon_shoe",
};

describe("resolveBookedPricing", () => {
  it("prefers the PR-0 stamp verbatim", () => {
    const stamp = {
      experienceSlug: "pizza-bowl",
      laneCount: 3,
      durationMultiplier: 1.5,
      pricingMode: "per_lane" as const,
    };
    const r = resolveBookedPricing({
      bookingMetadata: { bowling: stamp },
      playerCount: 12,
      lines: [line({})],
    });
    expect(r).toEqual({ ...stamp, source: "stamp" });
  });

  it("ignores malformed stamps and derives instead", () => {
    const r = resolveBookedPricing({
      bookingMetadata: { bowling: { pricingMode: "nonsense" } },
      playerCount: 2,
      lines: [line({ quantity: 2 })],
      experienceKind: "open",
      experienceSlug: "fun-4-all",
    });
    expect(r.source).toBe("derived");
    expect(r.pricingMode).toBe("per_person");
  });

  it("derives per-person: qty 4 for 4 players → multiplier 1", () => {
    const r = resolveBookedPricing({
      playerCount: 4,
      lines: [line({ quantity: 4 })],
      experienceKind: "open",
      experienceSlug: "fun-4-all",
    });
    expect(r.pricingMode).toBe("per_person");
    expect(r.durationMultiplier).toBe(1);
  });

  it("derives per-lane for hourly: 8 players → 2 lanes, qty 3 → multiplier 1.5", () => {
    const r = resolveBookedPricing({
      playerCount: 8,
      lines: [line({ quantity: 3, productKind: "hourly" })],
      experienceKind: "hourly",
      experienceSlug: "lane-rental",
    });
    expect(r.pricingMode).toBe("per_lane");
    expect(r.laneCount).toBe(2);
    expect(r.durationMultiplier).toBe(1.5);
  });

  it("pizza-bowl slug is per-lane even when the experience kind is open", () => {
    const r = resolveBookedPricing({
      playerCount: 5,
      lines: [line({ quantity: 1 })],
      experienceKind: "open",
      experienceSlug: "pizza-bowl",
    });
    expect(r.pricingMode).toBe("per_lane");
    expect(r.laneCount).toBe(1);
  });

  it("refuses non-reconciling arithmetic instead of guessing", () => {
    expect(
      code(() =>
        resolveBookedPricing({
          playerCount: 4,
          lines: [line({ quantity: 5 })],
          experienceKind: "open",
          experienceSlug: "fun-4-all",
        }),
      ),
    ).toBe("pricing_unresolvable");
  });

  it("refuses when no experience was resolved (legacy path)", () => {
    expect(code(() => resolveBookedPricing({ playerCount: 2, lines: [line({})] }))).toBe(
      "pricing_unresolvable",
    );
  });

  it("refuses zero or multiple primary lines", () => {
    expect(
      code(() =>
        resolveBookedPricing({
          playerCount: 2,
          lines: [line({ productKind: "addon_shoe" })],
          experienceKind: "open",
        }),
      ),
    ).toBe("pricing_unresolvable");
    expect(
      code(() =>
        resolveBookedPricing({
          playerCount: 2,
          lines: [line({}), line({ squareProductId: 2 })],
          experienceKind: "open",
        }),
      ),
    ).toBe("pricing_unresolvable");
  });
});

describe("repriceBowling", () => {
  const perPerson = {
    experienceSlug: "fun-4-all",
    laneCount: 1,
    durationMultiplier: 1,
    pricingMode: "per_person" as const,
    source: "stamp" as const,
  };

  it("per-person: players 2→4 doubles the primary quantity", () => {
    const r = repriceBowling({
      booked: perPerson,
      currentPlayerCount: 2,
      lines: [line({ quantity: 2 })],
      spec: { playerCount: 4 },
      shoeCatalog: [],
    });
    expect(r.newPlayerCount).toBe(4);
    const primary = r.lines.find((l) => l.role === "primary")!;
    expect(primary.quantity).toBe(4);
    expect(primary.unitPriceCents).toBe(1999);
  });

  it("carryPrimary passes the lane line through untouched (legacy shoe-only edits)", () => {
    const r = repriceBowling({
      booked: { ...perPerson, source: "derived" },
      currentPlayerCount: 2,
      lines: [line({ quantity: 3, unitPriceCents: 1750 })], // qty that would NOT reconcile
      spec: { shoes: { 7: 2 } },
      shoeCatalog: [SHOES],
      carryPrimary: true,
    });
    const primary = r.lines.find((l) => l.role === "primary")!;
    expect(primary.quantity).toBe(3);
    expect(primary.unitPriceCents).toBe(1750);
    expect(r.lines.find((l) => l.role === "shoe")!.quantity).toBe(2);
  });

  it("per-lane: lanes 1→2 doubles the primary; players don't move it", () => {
    const r = repriceBowling({
      booked: { ...perPerson, pricingMode: "per_lane", experienceSlug: "pizza-bowl" },
      currentPlayerCount: 5,
      lines: [line({ quantity: 1, productKind: "open" })],
      spec: { laneCount: 2, playerCount: 9 },
      shoeCatalog: [],
    });
    expect(r.newLaneCount).toBe(2);
    expect(r.lines.find((l) => l.role === "primary")!.quantity).toBe(2);
  });

  it("honors the duration multiplier (2h rental)", () => {
    const r = repriceBowling({
      booked: {
        ...perPerson,
        pricingMode: "per_lane",
        laneCount: 1,
        durationMultiplier: 2,
        experienceSlug: "lane-rental",
      },
      currentPlayerCount: 4,
      lines: [line({ quantity: 2, productKind: "hourly" })],
      spec: { laneCount: 3 },
      shoeCatalog: [],
    });
    expect(r.lines.find((l) => l.role === "primary")!.quantity).toBe(6);
  });

  it("per-person derives lanes from players and flags explicit laneCount", () => {
    const r = repriceBowling({
      booked: perPerson,
      currentPlayerCount: 2,
      lines: [line({ quantity: 2 })],
      spec: { playerCount: 7, laneCount: 1 },
      shoeCatalog: [],
    });
    expect(r.newLaneCount).toBe(1); // explicit wins…
    expect(r.warnings.some((w) => w.code === "lane_count_ignored")).toBe(true);
  });

  it("carries stored shoes when spec.shoes is omitted", () => {
    const r = repriceBowling({
      booked: perPerson,
      currentPlayerCount: 2,
      lines: [
        line({ quantity: 2 }),
        line({
          squareProductId: 7,
          label: "Shoe Rental",
          quantity: 2,
          unitPriceCents: 500,
          productKind: "addon_shoe",
          catalogPriceCents: 500,
          squareCatalogObjectId: "CAT_SHOE",
        }),
      ],
      spec: { playerCount: 3 },
      shoeCatalog: [SHOES],
    });
    expect(r.lines.find((l) => l.role === "shoe")!.quantity).toBe(2);
  });

  it("spec.shoes wins wholesale: resize, drop, and add-new-product", () => {
    const r = repriceBowling({
      booked: perPerson,
      currentPlayerCount: 2,
      lines: [
        line({ quantity: 2 }),
        line({
          squareProductId: 7,
          label: "Shoe Rental",
          quantity: 2,
          unitPriceCents: 500,
          productKind: "addon_shoe",
          catalogPriceCents: 500,
          squareCatalogObjectId: "CAT_SHOE",
        }),
        line({
          squareProductId: 8,
          label: "Kids Shoe Rental",
          quantity: 1,
          unitPriceCents: 400,
          productKind: "addon_shoe",
          catalogPriceCents: 400,
          squareCatalogObjectId: "CAT_KSHOE",
        }),
      ],
      spec: { shoes: { 7: 4, 9: 1 } }, // resize 7, drop 8, add product 9
      shoeCatalog: [
        SHOES,
        {
          squareProductId: 9,
          label: "VIP Shoe Rental",
          priceCents: 700,
          squareCatalogObjectId: "CAT_VSHOE",
          productKind: "addon_shoe",
        },
      ],
    });
    const shoes = r.lines.filter((l) => l.role === "shoe");
    expect(shoes).toHaveLength(2);
    expect(shoes.find((l) => l.squareProductId === 7)!.quantity).toBe(4);
    expect(shoes.find((l) => l.squareProductId === 9)!.unitPriceCents).toBe(700);
    expect(shoes.some((l) => l.squareProductId === 8)).toBe(false);
  });

  it("refuses unknown or negative shoe inputs", () => {
    const base = {
      booked: perPerson,
      currentPlayerCount: 2,
      lines: [line({ quantity: 2 })],
      shoeCatalog: [SHOES],
    };
    expect(code(() => repriceBowling({ ...base, spec: { shoes: { 99: 1 } } }))).toBe(
      "pricing_unresolvable",
    );
    expect(code(() => repriceBowling({ ...base, spec: { shoes: { 7: -1 } } }))).toBe(
      "pricing_unresolvable",
    );
  });

  it("keeps a booked below-catalog price and warns (never silently reprices)", () => {
    const r = repriceBowling({
      booked: perPerson,
      currentPlayerCount: 2,
      lines: [line({ quantity: 2, unitPriceCents: 1499, catalogPriceCents: 1999 })],
      spec: { playerCount: 3 },
      shoeCatalog: [],
    });
    const primary = r.lines.find((l) => l.role === "primary")!;
    expect(primary.unitPriceCents).toBe(1499);
    expect(primary.priceHeld).toBe(true);
    expect(r.warnings.some((w) => w.code === "price_held")).toBe(true);
  });

  it("carries non-shoe secondaries (food add-ons) unchanged", () => {
    const r = repriceBowling({
      booked: perPerson,
      currentPlayerCount: 2,
      lines: [
        line({ quantity: 2 }),
        line({
          squareProductId: 20,
          label: "Pizza Package",
          quantity: 1,
          unitPriceCents: 2500,
          productKind: "addon_food",
          catalogPriceCents: 2500,
          squareCatalogObjectId: "CAT_PIZZA",
        }),
      ],
      spec: { playerCount: 6 },
      shoeCatalog: [],
    });
    const food = r.lines.find((l) => l.squareProductId === 20)!;
    expect(food.quantity).toBe(1);
    expect(food.role).toBe("secondary");
  });

  it("refuses rows without a primary line", () => {
    expect(
      code(() =>
        repriceBowling({
          booked: perPerson,
          currentPlayerCount: 2,
          lines: [line({ productKind: "addon_food" })],
          spec: {},
          shoeCatalog: [],
        }),
      ),
    ).toBe("pricing_unresolvable");
  });

  describe("duration changes (hourly)", () => {
    const hourly = {
      experienceSlug: "lane-rental",
      laneCount: 2,
      durationMultiplier: 1.5,
      pricingMode: "per_lane" as const,
      source: "stamp" as const,
    };
    const hourlyLine = line({ quantity: 3, productKind: "hourly", label: "Lane Rental" });

    it("swaps the multiplier: 1.5h → 2h scales the primary quantity", () => {
      const r = repriceBowling({
        booked: hourly,
        currentPlayerCount: 8,
        lines: [hourlyLine],
        spec: {},
        shoeCatalog: [],
        durationOption: {
          id: 5,
          label: "2 Hours",
          squareMultiplier: 2,
          overrideSquareProductId: null,
          overridePriceCents: null,
          overrideCatalogObjectId: null,
        },
      });
      // perUnit = 3 / (2 lanes × 1.5) = 1 → new qty = 1 × 2 lanes × 2 = 4.
      expect(r.lines.find((l) => l.role === "primary")!.quantity).toBe(4);
      expect(r.newDurationMultiplier).toBe(2);
    });

    it("swaps to the override product at its live catalog price", () => {
      const r = repriceBowling({
        booked: hourly,
        currentPlayerCount: 8,
        lines: [hourlyLine],
        spec: {},
        shoeCatalog: [],
        durationOption: {
          id: 5,
          label: "2 Hours",
          squareMultiplier: 2,
          overrideSquareProductId: 44,
          overridePriceCents: 3499,
          overrideCatalogObjectId: "CAT_2H",
        },
        desiredPrimary: {
          squareProductId: 44,
          label: "Lane Rental 2H",
          priceCents: 3499,
          squareCatalogObjectId: "CAT_2H",
          productKind: "hourly",
        },
      });
      const primary = r.lines.find((l) => l.role === "primary")!;
      expect(primary.squareProductId).toBe(44);
      expect(primary.unitPriceCents).toBe(3499);
      expect(primary.quantity).toBe(4);
    });

    it("warns when a discounted booked price is dropped by the product swap", () => {
      const r = repriceBowling({
        booked: hourly,
        currentPlayerCount: 8,
        lines: [line({ quantity: 3, productKind: "hourly", unitPriceCents: 1499 })],
        spec: {},
        shoeCatalog: [],
        durationOption: {
          id: 5,
          label: "2 Hours",
          squareMultiplier: 2,
          overrideSquareProductId: 44,
          overridePriceCents: 3499,
          overrideCatalogObjectId: "CAT_2H",
        },
        desiredPrimary: {
          squareProductId: 44,
          label: "Lane Rental 2H",
          priceCents: 3499,
          squareCatalogObjectId: "CAT_2H",
          productKind: "hourly",
        },
      });
      expect(r.warnings.some((w) => w.code === "price_hold_dropped")).toBe(true);
    });

    it("refuses duration options on per-person experiences", () => {
      expect(
        code(() =>
          repriceBowling({
            booked: perPerson,
            currentPlayerCount: 2,
            lines: [line({ quantity: 2 })],
            spec: {},
            shoeCatalog: [],
            durationOption: {
              id: 5,
              label: "2 Hours",
              squareMultiplier: 2,
              overrideSquareProductId: null,
              overridePriceCents: null,
              overrideCatalogObjectId: null,
            },
          }),
        ),
      ).toBe("pricing_unresolvable");
    });
  });
});

describe("repriceKbfExtras", () => {
  it("prices paid adults at count × 2 games with the right catalog id", () => {
    const lines = repriceKbfExtras({
      isVip: false,
      isFriday: false,
      counts: { kbfKidCount: 2, fbfAdultCount: 0, paidAdultCount: 2 },
    });
    expect(lines).toHaveLength(1);
    expect(lines[0].quantity).toBe(4); // 2 adults × 2 games
    expect(lines[0].unitPriceCents).toBe(500); // Mon–Thu non-VIP
    expect(lines[0].role).toBe("kbf_extra");
  });

  it("VIP adds per-person upcharge lines for kids and FBF adults", () => {
    const lines = repriceKbfExtras({
      isVip: true,
      isFriday: true,
      counts: { kbfKidCount: 3, fbfAdultCount: 1, paidAdultCount: 1 },
    });
    expect(lines).toHaveLength(3);
    const adult = lines.find((l) => l.label.startsWith("Adult Game"))!;
    expect(adult.unitPriceCents).toBe(700); // Fri VIP
    expect(lines.find((l) => l.label === "Kids Bowl Free VIP")!.quantity).toBe(3);
    expect(lines.find((l) => l.label === "Families Bowl Free VIP")!.quantity).toBe(1);
  });

  it("free-only non-VIP parties produce no money lines", () => {
    expect(
      repriceKbfExtras({
        isVip: false,
        isFriday: false,
        counts: { kbfKidCount: 4, fbfAdultCount: 2, paidAdultCount: 0 },
      }),
    ).toHaveLength(0);
  });
});

describe("repriceRaceDelta", () => {
  const heats: HeatMeta[] = [
    {
      productId: "P1",
      track: "pro",
      heatId: "2026-07-15T14:00",
      assignedTo: "m1",
      tier: "starter",
      category: "adult",
      bmiPersonId: "111",
      racer: "Ann",
      bmiLineId: "L1",
    },
    {
      productId: "P1",
      track: "pro",
      heatId: "2026-07-15T14:30",
      assignedTo: "m1",
      tier: "starter",
      category: "adult",
      bmiPersonId: "111",
      racer: "Ann",
      bmiLineId: "L2",
    },
    {
      productId: "P1",
      track: "pro",
      heatId: "2026-07-15T14:00",
      assignedTo: "m2",
      tier: "starter",
      category: "adult",
      bmiPersonId: "222",
      racer: "Bob",
      bmiLineId: "L3",
    },
  ];
  // Category-aware resolver: P1 is the adult product; the junior counterpart
  // is a DIFFERENT product (P1J) with its own price + catalog id — mirrors
  // plan.ts resolveRaceProductForCategory.
  const resolve = (productId: string, category: "adult" | "junior") =>
    productId === "P1" || productId === "P1J"
      ? {
          bmiProductId: category === "junior" ? "P1J" : "P1",
          label: `P1 (${category})`,
          priceCents: category === "junior" ? 2000 : 2500,
          catalogObjectId: category === "junior" ? "CAT_J" : "CAT_A",
        }
      : null;

  it("an added racer joins every distinct surviving heat slot", () => {
    const r = repriceRaceDelta({
      heatsMeta: heats,
      add: [{ firstName: "Cam" }],
      removeHeatIndexes: [],
      resolveProduct: resolve,
    });
    // Distinct heatIds: 14:00 and 14:30 → 2 heat lines, no license.
    expect(r.addedLines.filter((l) => l.role === "race")).toHaveLength(2);
    expect(r.addedLines.every((l) => l.unitPriceCents === 2500)).toBe(true);
    expect(r.addedLines.every((l) => l.squareCatalogObjectId === "CAT_A")).toBe(true);
    expect(r.addedLines.some((l) => l.role === "license")).toBe(false);
    // Booking plan mirrors the priced lines exactly.
    expect(r.raceAdds).toHaveLength(1);
    expect(r.raceAdds[0].heats).toHaveLength(2);
    expect(r.raceAdds[0].heats.every((h) => h.bmiProductId === "P1")).toBe(true);
  });

  it("cross-category add resolves the counterpart product for pricing AND booking", () => {
    const r = repriceRaceDelta({
      heatsMeta: heats, // adult heats (P1)
      add: [{ firstName: "Kid", category: "junior", isNew: true }],
      removeHeatIndexes: [],
      resolveProduct: resolve,
    });
    const raceLines = r.addedLines.filter((l) => l.role === "race");
    expect(raceLines.every((l) => l.unitPriceCents === 2000)).toBe(true);
    expect(raceLines.every((l) => l.squareCatalogObjectId === "CAT_J")).toBe(true);
    const license = r.addedLines.find((l) => l.role === "license")!;
    expect(license.unitPriceCents).toBe(499);
    // bmi-sync books the JUNIOR product, not the heats' adult product.
    expect(r.raceAdds[0].category).toBe("junior");
    expect(r.raceAdds[0].heats.every((h) => h.bmiProductId === "P1J")).toBe(true);
  });

  it("a resolver refusal (string) surfaces as pricing_unresolvable", () => {
    expect(
      code(() =>
        repriceRaceDelta({
          heatsMeta: heats,
          add: [{ firstName: "Kid", category: "junior" }],
          removeHeatIndexes: [],
          resolveProduct: () => "juniors can't race this track",
        }),
      ),
    ).toBe("pricing_unresolvable");
  });

  it("removals resolve bmi line refs, prices, and catalog ids by index", () => {
    const r = repriceRaceDelta({
      heatsMeta: heats,
      add: [],
      removeHeatIndexes: [2],
      resolveProduct: resolve,
    });
    expect(r.removedHeats).toHaveLength(1);
    expect(r.removedHeats[0].bmiLineId).toBe("L3");
    expect(r.removedHeats[0].unitPriceCents).toBe(2500);
    expect(r.removedHeats[0].catalogObjectId).toBe("CAT_A");
  });

  it("an out-of-range removal index is plan_stale (metadata drifted)", () => {
    expect(
      code(() =>
        repriceRaceDelta({
          heatsMeta: heats,
          add: [],
          removeHeatIndexes: [9],
          resolveProduct: resolve,
        }),
      ),
    ).toBe("plan_stale");
  });

  it("removing every heat with no adds is refused — that's a cancellation", () => {
    expect(
      code(() =>
        repriceRaceDelta({
          heatsMeta: heats,
          add: [],
          removeHeatIndexes: [0, 1, 2],
          resolveProduct: resolve,
        }),
      ),
    ).toBe("unsupported_kind");
  });

  it("adding with no surviving heats is refused", () => {
    expect(
      code(() =>
        repriceRaceDelta({
          heatsMeta: heats.slice(0, 1),
          add: [{ firstName: "Cam" }],
          removeHeatIndexes: [0],
          resolveProduct: resolve,
        }),
      ),
    ).toBe("pricing_unresolvable");
  });

  it("removing a heat with no resolvable price warns instead of guessing", () => {
    const r = repriceRaceDelta({
      heatsMeta: [{ ...heats[0], productId: "UNKNOWN" }, heats[1]],
      add: [],
      removeHeatIndexes: [0],
      resolveProduct: resolve,
    });
    expect(r.removedHeats[0].unitPriceCents).toBe(0);
    expect(r.removedHeats[0].catalogObjectId).toBeNull();
    expect(r.warnings.some((w) => w.code === "heat_price_unknown")).toBe(true);
  });
});

describe("repriceComboRacers", () => {
  const combo = getComboSpecial("race-bowl");

  it.skipIf(!combo?.revenueSplit)(
    "itemizes via the booking seam: entity split sums to per-person price × roster",
    () => {
      const date = "2026-07-15"; // Wednesday → weekday pricing
      const r = repriceComboRacers({
        combo: combo!,
        date,
        racers: [
          { id: "a", isNew: true },
          { id: "b", isNew: false },
        ],
      });
      expect(r.byEntity.length).toBeGreaterThanOrEqual(2);
      const total = r.byEntity
        .flatMap((e) => e.lines)
        .reduce((s, l) => s + l.unitPriceCents * l.quantity, 0);
      expect(total).toBe(comboPriceCentsForDate(combo!, date) * 2);
    },
  );

  it("refuses an empty roster", () => {
    expect(code(() => repriceComboRacers({ combo: combo!, date: "2026-07-15", racers: [] }))).toBe(
      "pricing_unresolvable",
    );
  });
});
