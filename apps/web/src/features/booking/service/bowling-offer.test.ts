import { describe, expect, it } from "vitest";
import {
  bowlingLaneCount,
  buildBowlingLineItems,
  effectiveBowlingOptionId,
  isPerLaneExperience,
  longestFittingOptionId,
  slotAllowedForExperience,
} from "./bowling-offer";
import type {
  BowlingExperienceWithDetails,
  BowlingExperienceDurationOption,
  BowlingExperienceItem,
} from "@/lib/bowling-db";

function makeItem(over: Partial<BowlingExperienceItem> = {}): BowlingExperienceItem {
  return {
    id: 1,
    experienceId: 10,
    squareProductId: 100,
    label: "Lane Rental (1hr)",
    priceCents: 3999,
    depositPct: 50,
    squareCatalogObjectId: "CAT_LANE",
    quantity: 1,
    sortOrder: 0,
    productKind: "open",
    ...over,
  };
}

function makeExp(over: Partial<BowlingExperienceWithDetails> = {}): BowlingExperienceWithDetails {
  return {
    id: 10,
    slug: "regular-mon-thur",
    label: "Regular Lanes",
    kind: "hourly",
    isVip: false,
    description: null,
    sortOrder: 0,
    isActive: true,
    daysOfWeek: [1, 2, 3, 4],
    squareModifierListIds: [],
    insertedAt: "2026-01-01",
    qamfWebOfferId: 154,
    qamfOptionType: "Time",
    qamfOptionId: 1227,
    qamfOfferDurationMinutes: null,
    items: [makeItem()],
    durationOptions: [],
    ...over,
  };
}

const opt90: BowlingExperienceDurationOption = {
  id: 1,
  experienceId: 10,
  centerCode: "TXBSQN0FEKQ11",
  qamfOptionId: 1227,
  durationMinutes: 90,
  label: "1.5 Hours",
  squareMultiplier: 1,
  sortOrder: 0,
  overrideSquareProductId: null,
  overridePriceCents: null,
  overrideDepositPct: null,
  overrideCatalogObjectId: null,
};

const opt120: BowlingExperienceDurationOption = {
  ...opt90,
  id: 2,
  qamfOptionId: 1228,
  durationMinutes: 120,
  label: "2 Hours",
  squareMultiplier: 2,
  sortOrder: 1,
  overrideSquareProductId: 200,
  overridePriceCents: 4999,
  overrideDepositPct: 100,
  overrideCatalogObjectId: "CAT_LANE_2H",
};

describe("bowlingLaneCount", () => {
  it("6 bowlers per lane, minimum 1", () => {
    expect(bowlingLaneCount(1)).toBe(1);
    expect(bowlingLaneCount(6)).toBe(1);
    expect(bowlingLaneCount(7)).toBe(2);
    expect(bowlingLaneCount(24)).toBe(4);
  });
});

describe("isPerLaneExperience", () => {
  it("hourly and pizza-bowl are per-lane; open packages are per-person", () => {
    expect(isPerLaneExperience({ kind: "hourly", slug: "regular-mon-thur" })).toBe(true);
    expect(isPerLaneExperience({ kind: "open", slug: "pizza-bowl-vip" })).toBe(true);
    expect(isPerLaneExperience({ kind: "open", slug: "fun-4-all" })).toBe(false);
    expect(isPerLaneExperience({ kind: "kbf", slug: "kbf-regular" })).toBe(false);
  });
});

describe("buildBowlingLineItems", () => {
  it("per-lane primary scales by laneCount × durationMultiplier", () => {
    const lines = buildBowlingLineItems(makeExp(), opt120, 8, 2);
    expect(lines).toHaveLength(1);
    // override product swaps in; qty = 1 × 2 lanes × 2 multiplier
    expect(lines[0]).toMatchObject({
      squareProductId: 200,
      quantity: 4,
      priceCents: 4999,
      depositPct: 100,
      squareCatalogObjectId: "CAT_LANE_2H",
    });
  });

  it("no duration option → base product, multiplier 1", () => {
    const lines = buildBowlingLineItems(makeExp(), null, 8, 2);
    expect(lines[0]).toMatchObject({ squareProductId: 100, quantity: 2, priceCents: 3999 });
  });

  it("per-person primary scales by playerCount; secondaries scale per lane", () => {
    const exp = makeExp({
      slug: "fun-4-all",
      kind: "open",
      items: [
        makeItem(),
        makeItem({ id: 2, squareProductId: 101, label: "Shoes", sortOrder: 1, quantity: 1 }),
      ],
    });
    const lines = buildBowlingLineItems(exp, null, 5, 1);
    expect(lines[0].quantity).toBe(5); // per person
    expect(lines[1].quantity).toBe(1); // per lane
  });

  it("90-min option without override keeps the base product", () => {
    const lines = buildBowlingLineItems(makeExp(), opt90, 4, 1);
    expect(lines[0]).toMatchObject({ squareProductId: 100, quantity: 1, priceCents: 3999 });
  });
});

describe("effectiveBowlingOptionId (Pizza Bowl short-booking guard)", () => {
  it("explicit duration pick wins", () => {
    expect(effectiveBowlingOptionId(opt120, { qamfOptionId: 1227 }, 999)).toBe(1228);
  });

  it("falls back to the experience's seeded option — never the slot's guess", () => {
    // Fixed-duration package (Pizza Bowl): no duration buttons, seeded option
    // must win over the QAMF-derived slot option (the 60-min short-booking bug).
    expect(effectiveBowlingOptionId(null, { qamfOptionId: 1284 }, 999)).toBe(1284);
  });

  it("slot option only as a true last resort", () => {
    expect(effectiveBowlingOptionId(null, { qamfOptionId: null }, 999)).toBe(999);
  });
});

describe("longestFittingOptionId (Midnight Madness on the shared Fri-Sun offer)", () => {
  const friSun = makeExp({
    slug: "regular-fri-sun",
    qamfWebOfferId: 158,
    qamfOptionId: null,
    durationOptions: [
      { ...opt90, id: 11, qamfOptionId: 1259, durationMinutes: 90 },
      { ...opt120, id: 12, qamfOptionId: 1260, durationMinutes: 120 },
      { ...opt90, id: 13, qamfOptionId: 1258, durationMinutes: 60 },
    ],
  });

  it("picks the longest configured option remaining on the slot", () => {
    expect(
      longestFittingOptionId({ webOfferId: 158, availableTimeOptionIds: [1258, 1259, 1260] }, [
        friSun,
      ]),
    ).toBe(1260);
  });

  it("near close the route strips long options — picks the longest that's left", () => {
    expect(
      longestFittingOptionId({ webOfferId: 158, availableTimeOptionIds: [1258, 1259] }, [friSun]),
    ).toBe(1259);
    expect(
      longestFittingOptionId({ webOfferId: 158, availableTimeOptionIds: [1258] }, [friSun]),
    ).toBe(1258);
  });

  it("ignores experiences on other offers and unknown option ids", () => {
    expect(
      longestFittingOptionId({ webOfferId: 159, availableTimeOptionIds: [1258] }, [friSun]),
    ).toBeUndefined();
    expect(
      longestFittingOptionId({ webOfferId: 158, availableTimeOptionIds: [999] }, [friSun]),
    ).toBeUndefined();
  });

  it("undefined when the slot has no Time options (Game/Unlimited offers)", () => {
    expect(longestFittingOptionId({ webOfferId: 158 }, [friSun])).toBeUndefined();
  });
});

describe("slotAllowedForExperience (Midnight Madness late-night gate)", () => {
  it("MM blocked before 10:30 PM, allowed from 10:30 PM through post-midnight", () => {
    expect(slotAllowedForExperience("midnight-madness", 22 * 60)).toBe(false);
    expect(slotAllowedForExperience("midnight-madness", 22 * 60 + 30)).toBe(true);
    expect(slotAllowedForExperience("midnight-madness-vip", 24 * 60)).toBe(true); // midnight
    expect(slotAllowedForExperience("midnight-madness-vip", 25 * 60)).toBe(true); // 1 AM
  });

  it("every other slug is unrestricted", () => {
    expect(slotAllowedForExperience("regular-fri-sun", 11 * 60)).toBe(true);
    expect(slotAllowedForExperience("pizza-bowl", 12 * 60)).toBe(true);
    expect(slotAllowedForExperience("fun-4-all", 9 * 60)).toBe(true);
  });
});
