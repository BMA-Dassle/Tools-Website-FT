import { describe, it, expect } from "vitest";
import {
  bmiBookingTarget,
  resolveBuildPair,
  raceBuildKeyFromParts,
  getRaceProductById,
} from "./race-products";
import { raceUsesZeroBmiModel } from "./race";
import { raceItemChargeLines, buildRaceChargeLines } from "./checkout";
import { getPackage, packagePerRacerPrice } from "./packages";
import {
  emptySession,
  type RaceItem,
  type PartyMember,
  type RaceHeatAssignment,
} from "../state/types";

const BUILD_PAGE = "49504534";

// Real registry ids (race-products.ts).
const SINGLE_STARTER_RED = "24960859"; // adult weekday Starter Red, $20.99
const COMBO_PRO_MEGA = "45094787"; // adult Pro Mega 3-Pack, $49.98, raceCount 3
const COMBO_INT_WEEKDAY_RED = "45094857"; // mixed-track Int 3-Pack parent (Red)
const COMBO_INT_WEEKDAY_BLUE_TWIN = "45094906"; // Blue twin — NOT a top-level product
const PKG_ID = "ultimate-qualifier-mega";

function member(id: string, over: Partial<PartyMember> = {}): PartyMember {
  return { id, firstName: id, isNewRacer: false, category: "adult", ...over };
}

function heat(over: Partial<RaceHeatAssignment> = {}): RaceHeatAssignment {
  // category defaults to "adult" — mirrors entriesForPick, which writes
  // (category, tier, track) onto every heat at pick time.
  return {
    productId: SINGLE_STARTER_RED,
    track: "Red",
    category: "adult",
    heatId: "2026-07-01T15:00:00",
    bmiLineId: null,
    assignedTo: "r1",
    ...over,
  };
}

function raceItem(over: Partial<RaceItem> = {}): RaceItem {
  return {
    id: "race-1",
    kind: "race",
    date: "2026-07-01",
    productIdAdult: null,
    productIdJunior: null,
    productTrackAdult: null,
    productTrackJunior: null,
    heats: [],
    packageId: null,
    povQuantity: 0,
    addons: [],
    rookiePack: null,
    ...over,
  };
}

function sessionWith(items: RaceItem[], party: PartyMember[]) {
  return { ...emptySession({ entryBrand: "fasttrax" }), items, party };
}

describe("raceBuildKeyFromParts", () => {
  it("formats category:tier:track and is null without a track", () => {
    expect(raceBuildKeyFromParts("adult", "intermediate", "Blue")).toBe("adult:intermediate:Blue");
    expect(raceBuildKeyFromParts("adult", "intermediate", null)).toBeNull();
  });
});

describe("resolveBuildPair + bmiBookingTarget — $0 build resolution", () => {
  it("resolves a combo Blue twin (NOT a top-level product) via (category,tier,track) parts", () => {
    // Pre-fix this id hit getRaceProductById→null→passthrough (pageId===productId).
    expect(getRaceProductById(COMBO_INT_WEEKDAY_BLUE_TWIN)).toBeNull();
    const pair = resolveBuildPair({
      productId: COMBO_INT_WEEKDAY_BLUE_TWIN,
      category: "adult",
      tier: "intermediate",
      track: "Blue",
    });
    expect(pair).not.toBeNull();
    const target = bmiBookingTarget(COMBO_INT_WEEKDAY_BLUE_TWIN, {
      category: "adult",
      tier: "intermediate",
      track: "Blue",
    });
    expect(target.pageId).toBe(BUILD_PAGE); // $0 build page, never pageId===productId
    expect(target.productId).not.toBe(COMBO_INT_WEEKDAY_BLUE_TWIN);
  });

  it("withLicense picks a different $0 twin than raceOnly", () => {
    const raceOnly = bmiBookingTarget(COMBO_INT_WEEKDAY_BLUE_TWIN, {
      category: "adult",
      tier: "intermediate",
      track: "Blue",
    });
    const withLic = bmiBookingTarget(COMBO_INT_WEEKDAY_BLUE_TWIN, {
      withLicense: true,
      category: "adult",
      tier: "intermediate",
      track: "Blue",
    });
    expect(withLic.pageId).toBe(BUILD_PAGE);
    expect(withLic.productId).not.toBe(raceOnly.productId);
  });

  it("single races still resolve to the $0 page via productId (no parts)", () => {
    const target = bmiBookingTarget(SINGLE_STARTER_RED);
    expect(target.pageId).toBe(BUILD_PAGE);
  });
});

describe("raceUsesZeroBmiModel — packages + combos now qualify", () => {
  it("true for a single race", () => {
    expect(
      raceUsesZeroBmiModel(
        raceItem({
          productIdAdult: SINGLE_STARTER_RED,
          heats: [heat({ tier: "starter", category: "adult" })],
        }),
      ),
    ).toBe(true);
  });

  it("true for a same-track Mega combo (was excluded by packType==='combo')", () => {
    expect(
      raceUsesZeroBmiModel(
        raceItem({
          productIdAdult: COMBO_PRO_MEGA,
          heats: [
            heat({ productId: COMBO_PRO_MEGA, track: "Mega", tier: "pro", category: "adult" }),
            heat({ productId: COMBO_PRO_MEGA, track: "Mega", tier: "pro", category: "adult" }),
            heat({ productId: COMBO_PRO_MEGA, track: "Mega", tier: "pro", category: "adult" }),
          ],
        }),
      ),
    ).toBe(true);
  });

  it("true for a mixed-track combo with a Blue-twin heat (was the wrong-page break)", () => {
    expect(
      raceUsesZeroBmiModel(
        raceItem({
          productIdAdult: COMBO_INT_WEEKDAY_RED,
          heats: [
            heat({ productId: COMBO_INT_WEEKDAY_RED, track: "Red", tier: "intermediate" }),
            heat({
              productId: COMBO_INT_WEEKDAY_BLUE_TWIN,
              track: "Blue",
              tier: "intermediate",
            }),
          ],
        }),
      ),
    ).toBe(true);
  });

  it("true for a package (parts written from the component tier + category)", () => {
    expect(
      raceUsesZeroBmiModel(
        raceItem({
          packageId: PKG_ID,
          heats: [
            heat({ productId: "x-starter", track: "Mega", tier: "starter", category: "adult" }),
            heat({
              productId: "x-intermediate",
              track: "Mega",
              tier: "intermediate",
              category: "adult",
            }),
          ],
        }),
      ),
    ).toBe(true);
  });

  it("false when an add-on is present", () => {
    expect(
      raceUsesZeroBmiModel(
        raceItem({
          productIdAdult: SINGLE_STARTER_RED,
          heats: [heat({ tier: "starter" })],
          addons: [{ id: "shuffly", qty: 1, selectedTime: "2026-07-01T16:00:00", bmiLineId: null }],
        }),
      ),
    ).toBe(false);
  });

  it("false when a heat resolves no build pair (unknown id, no parts)", () => {
    expect(
      raceUsesZeroBmiModel(raceItem({ heats: [heat({ productId: "99999999", track: null })] })),
    ).toBe(false);
  });
});

describe("raceItemChargeLines — pack-once / bundle / per-heat", () => {
  it("combo charges the pack TOTAL once per racer, NOT price × heats (the overcharge fix)", () => {
    const price = getRaceProductById(COMBO_PRO_MEGA)!.price; // 49.98 pack total
    const item = raceItem({
      productIdAdult: COMBO_PRO_MEGA,
      heats: Array.from({ length: 3 }, () =>
        heat({ productId: COMBO_PRO_MEGA, track: "Mega", tier: "pro", assignedTo: "r1" }),
      ),
    });
    const lines = raceItemChargeLines(item);
    expect(lines).toHaveLength(1);
    expect(lines[0].quantity).toBe(1); // one pack, not 3 heats
    expect(lines[0].amount).toBeCloseTo(price, 2); // 49.98, NOT 149.94
  });

  it("combo with 2 racers = 2 packs at the pack total", () => {
    const price = getRaceProductById(COMBO_PRO_MEGA)!.price;
    const heats = ["r1", "r2"].flatMap((rid) =>
      Array.from({ length: 3 }, () =>
        heat({ productId: COMBO_PRO_MEGA, track: "Mega", tier: "pro", assignedTo: rid }),
      ),
    );
    const lines = raceItemChargeLines(raceItem({ productIdAdult: COMBO_PRO_MEGA, heats }));
    expect(lines[0].quantity).toBe(2);
    expect(lines[0].amount).toBeCloseTo(price * 2, 2);
  });

  it("package charges packagePerRacerPrice × racers as ONE bundle line", () => {
    const pkg = getPackage(PKG_ID)!;
    const item = raceItem({
      packageId: PKG_ID,
      heats: [
        heat({ productId: "s", track: "Mega", tier: "starter", assignedTo: "r1" }),
        heat({ productId: "i", track: "Mega", tier: "intermediate", assignedTo: "r1" }),
      ],
    });
    const lines = raceItemChargeLines(item);
    expect(lines).toHaveLength(1);
    expect(lines[0].quantity).toBe(1);
    expect(lines[0].amount).toBeCloseTo(packagePerRacerPrice(pkg), 2);
  });

  it("single race charges per-heat price × heats", () => {
    const price = getRaceProductById(SINGLE_STARTER_RED)!.price;
    const item = raceItem({
      productIdAdult: SINGLE_STARTER_RED,
      heats: [
        heat({ tier: "starter", assignedTo: "r1" }),
        heat({ tier: "starter", assignedTo: "r1" }),
      ],
    });
    const lines = raceItemChargeLines(item);
    expect(lines[0].quantity).toBe(2);
    expect(lines[0].amount).toBeCloseTo(price * 2, 2);
  });

  it("excludeHeats drops only the redeemed heat objects (partial-safe)", () => {
    const price = getRaceProductById(SINGLE_STARTER_RED)!.price;
    const item = raceItem({
      productIdAdult: SINGLE_STARTER_RED,
      heats: [
        heat({ tier: "starter", assignedTo: "r1" }),
        heat({ tier: "starter", assignedTo: "r2" }),
      ],
    });
    // Exclude only the SECOND heat object (not the whole racer) — the other heat
    // still charges, so a racer with fewer credits than heats pays cash for the rest.
    const lines = raceItemChargeLines(item, new Set([item.heats[1]]));
    expect(lines[0].quantity).toBe(1); // only the un-redeemed heat charged
    expect(lines[0].amount).toBeCloseTo(price, 2);
  });
});

describe("buildRaceChargeLines — license dedup + standalone POV", () => {
  it("package bundle does NOT add a separate license line (bundle includes it)", () => {
    const session = sessionWith(
      [
        raceItem({
          packageId: PKG_ID,
          heats: [
            heat({ track: "Mega", tier: "starter", assignedTo: "r1" }),
            heat({ track: "Mega", tier: "intermediate", assignedTo: "r1" }),
          ],
        }),
      ],
      [member("r1", { isNewRacer: true })],
    );
    const lines = buildRaceChargeLines(session);
    expect(lines.some((l) => l.name === "FastTrax License")).toBe(false);
    expect(lines).toHaveLength(1); // just the bundle line
  });

  it("single race + new racer adds ONE license line", () => {
    const session = sessionWith(
      [
        raceItem({
          productIdAdult: SINGLE_STARTER_RED,
          heats: [heat({ tier: "starter", assignedTo: "r1" })],
        }),
      ],
      [member("r1", { isNewRacer: true })],
    );
    const license = buildRaceChargeLines(session).filter((l) => l.name === "FastTrax License");
    expect(license).toHaveLength(1);
    expect(license[0].quantity).toBe(1);
  });

  it("standalone POV adds a $5 × qty Square line (money lives on Square, not the $0 BMI line)", () => {
    const session = sessionWith(
      [
        raceItem({
          productIdAdult: SINGLE_STARTER_RED,
          povQuantity: 2,
          heats: [heat({ tier: "starter", assignedTo: "r1" })],
        }),
      ],
      [member("r1")],
    );
    const pov = buildRaceChargeLines(session).find((l) => l.name === "POV Race Video");
    expect(pov).toBeDefined();
    expect(pov!.quantity).toBe(2);
    expect(pov!.amount).toBeCloseTo(10, 2);
  });
});
