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
    packageIdAdult: null,
    packageIdJunior: null,
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
          packageIdAdult: PKG_ID,
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
      packageIdAdult: PKG_ID,
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
          packageIdAdult: PKG_ID,
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

  it("rookiePack flag folds license + POV into ONE 'Rookie Pack' line keyed rookie-pack", () => {
    // Kiosk mixed-party auto-enroll shape: 1 returning + 1 new racer,
    // rookiePack: true, povQuantity = new-racer count (KioskFlow effect).
    const session = sessionWith(
      [
        raceItem({
          productIdAdult: SINGLE_STARTER_RED,
          rookiePack: true,
          povQuantity: 1,
          heats: [
            heat({ tier: "starter", assignedTo: "r1" }),
            heat({ tier: "starter", assignedTo: "r2" }),
          ],
        }),
      ],
      [member("r1", { isNewRacer: true }), member("r2")],
    );
    const lines = buildRaceChargeLines(session);
    const rookie = lines.find((l) => l.name === "Rookie Pack");
    expect(rookie).toBeDefined();
    expect(rookie!.quantity).toBe(1);
    expect(rookie!.amount).toBe(4.99 + 4.99); // LICENSE_PRICE + POV_PRICE per new racer
    expect(rookie!.bmiProductId).toBe("rookie-pack"); // → SQ.ROOKIE_PACK on the day-of order
    expect(lines.some((l) => l.name === "FastTrax License")).toBe(false);
    expect(lines.some((l) => l.name === "POV Race Video")).toBe(false); // consumed by the pack
  });

  it("rookiePack flag: POV cameras beyond the pack's still book as POV Race Video", () => {
    const session = sessionWith(
      [
        raceItem({
          productIdAdult: SINGLE_STARTER_RED,
          rookiePack: true,
          povQuantity: 3, // 1 pack camera + 2 extras
          heats: [heat({ tier: "starter", assignedTo: "r1" })],
        }),
      ],
      [member("r1", { isNewRacer: true })],
    );
    const lines = buildRaceChargeLines(session);
    expect(lines.find((l) => l.name === "Rookie Pack")!.quantity).toBe(1);
    expect(lines.find((l) => l.name === "POV Race Video")!.quantity).toBe(2);
  });

  it("rookiePack opted OUT (false) keeps the plain license line", () => {
    const session = sessionWith(
      [
        raceItem({
          productIdAdult: SINGLE_STARTER_RED,
          rookiePack: false,
          heats: [heat({ tier: "starter", assignedTo: "r1" })],
        }),
      ],
      [member("r1", { isNewRacer: true })],
    );
    const lines = buildRaceChargeLines(session);
    expect(lines.some((l) => l.name === "Rookie Pack")).toBe(false);
    expect(lines.find((l) => l.name === "FastTrax License")!.quantity).toBe(1);
  });

  it("standalone POV adds a $4.99 × qty Square line (money lives on Square, not the $0 BMI line)", () => {
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
    expect(pov!.amount).toBeCloseTo(9.98, 2); // 2 × POV_PRICE
  });
});

// ── Per-category packages — the mixed-party undercharge fix (2026-07-19) ──
// A single item-level packageId let a mixed party's junior selection overwrite
// the adult variant, pricing EVERY racer at the junior per-racer price. These
// pin the per-category split: each category's heats price at ITS variant.

const UQ_ADULT = "ultimate-qualifier-weekday";
const UQ_JUNIOR = "ultimate-qualifier-weekday-junior";
const JUNIOR_STARTER_BLUE_NEW = "24960106"; // junior weekday Starter Blue (new racer), $15.99

function mixedPackageHeats(): RaceHeatAssignment[] {
  return [
    heat({ productId: "s-a", track: "Blue", tier: "starter", category: "adult", assignedTo: "r1" }),
    heat({
      productId: "i-a",
      track: "Blue",
      tier: "intermediate",
      category: "adult",
      assignedTo: "r1",
    }),
    heat({
      productId: "s-j",
      track: "Blue",
      tier: "starter",
      category: "junior",
      assignedTo: "r2",
    }),
    heat({
      productId: "i-j",
      track: "Blue",
      tier: "intermediate",
      category: "junior",
      assignedTo: "r2",
    }),
  ];
}

describe("raceItemChargeLines — per-category packages (mixed-party pricing)", () => {
  it("adult + junior variants price independently on separate lines", () => {
    const adultPkg = getPackage(UQ_ADULT)!;
    const juniorPkg = getPackage(UQ_JUNIOR)!;
    // The regression premise: the two variants really do price differently.
    expect(packagePerRacerPrice(adultPkg)).not.toBeCloseTo(packagePerRacerPrice(juniorPkg), 2);

    const lines = raceItemChargeLines(
      raceItem({
        packageIdAdult: UQ_ADULT,
        packageIdJunior: UQ_JUNIOR,
        heats: mixedPackageHeats(),
      }),
    );
    expect(lines).toHaveLength(2);
    const adultLine = lines.find((l) => l.name === adultPkg.name);
    const juniorLine = lines.find((l) => l.name === `${juniorPkg.name} (Junior)`);
    expect(adultLine).toBeDefined();
    expect(juniorLine).toBeDefined();
    expect(adultLine!.quantity).toBe(1);
    expect(adultLine!.amount).toBeCloseTo(packagePerRacerPrice(adultPkg), 2);
    expect(juniorLine!.quantity).toBe(1);
    expect(juniorLine!.amount).toBeCloseTo(packagePerRacerPrice(juniorPkg), 2);
  });

  it("adult package + junior SINGLE race: junior heats price per heat at the product price", () => {
    const juniorPrice = getRaceProductById(JUNIOR_STARTER_BLUE_NEW)!.price;
    const lines = raceItemChargeLines(
      raceItem({
        packageIdAdult: UQ_ADULT,
        productIdJunior: JUNIOR_STARTER_BLUE_NEW,
        heats: [
          heat({ productId: "s-a", track: "Blue", tier: "starter", assignedTo: "r1" }),
          heat({
            productId: JUNIOR_STARTER_BLUE_NEW,
            track: "Blue",
            tier: "starter",
            category: "junior",
            assignedTo: "r2",
          }),
        ],
      }),
    );
    const pkgLine = lines.find((l) => l.name === getPackage(UQ_ADULT)!.name);
    const singleLine = lines.find((l) => l.name === "Junior Starter Race Blue");
    expect(pkgLine).toBeDefined();
    expect(singleLine).toBeDefined();
    expect(singleLine!.quantity).toBe(1);
    expect(singleLine!.amount).toBeCloseTo(juniorPrice, 2);
  });
});

describe("buildRaceChargeLines — per-category license/POV suppression", () => {
  it("junior single-race NEW racer still pays the license alongside an adult package", () => {
    const session = sessionWith(
      [
        raceItem({
          packageIdAdult: UQ_ADULT,
          productIdJunior: JUNIOR_STARTER_BLUE_NEW,
          heats: [
            heat({ productId: "s-a", track: "Blue", tier: "starter", assignedTo: "r1" }),
            heat({
              productId: JUNIOR_STARTER_BLUE_NEW,
              track: "Blue",
              tier: "starter",
              category: "junior",
              assignedTo: "r2",
            }),
          ],
        }),
      ],
      [member("r1", { isNewRacer: true }), member("r2", { isNewRacer: true, category: "junior" })],
    );
    const license = buildRaceChargeLines(session).filter((l) => l.name === "FastTrax License");
    expect(license).toHaveLength(1);
    expect(license[0].quantity).toBe(1); // the junior only — adult license rides the bundle
  });

  it("standalone POV still charges when the package covers only part of the party", () => {
    const session = sessionWith(
      [
        raceItem({
          packageIdAdult: UQ_ADULT,
          productIdJunior: JUNIOR_STARTER_BLUE_NEW,
          povQuantity: 1,
          heats: [
            heat({ productId: "s-a", track: "Blue", tier: "starter", assignedTo: "r1" }),
            heat({
              productId: JUNIOR_STARTER_BLUE_NEW,
              track: "Blue",
              tier: "starter",
              category: "junior",
              assignedTo: "r2",
            }),
          ],
        }),
      ],
      [member("r1"), member("r2", { category: "junior" })],
    );
    const pov = buildRaceChargeLines(session).find((l) => l.name === "POV Race Video");
    expect(pov).toBeDefined();
    expect(pov!.quantity).toBe(1);
  });

  it("a new racer with NO heats pays no license (roster deselect / not-racing opt-out)", () => {
    const session = sessionWith(
      [
        raceItem({
          productIdAdult: SINGLE_STARTER_RED,
          heats: [heat({ tier: "starter", assignedTo: "r1" })],
        }),
      ],
      [member("r1", { isNewRacer: true }), member("spectator", { isNewRacer: true })],
    );
    const license = buildRaceChargeLines(session).filter((l) => l.name === "FastTrax License");
    expect(license).toHaveLength(1);
    expect(license[0].quantity).toBe(1); // r1 only — the heatless spectator pays nothing
  });

  it("partial package selection: bundle quantity = SELECTED racers, not the whole category", () => {
    // 3 adults in the party, but only 2 were checked in the picker's roster —
    // heats carry assignedTo for exactly those 2.
    const session = sessionWith(
      [
        raceItem({
          packageIdAdult: UQ_ADULT,
          heats: ["r1", "r2"].flatMap((rid) => [
            heat({ productId: "s-a", track: "Blue", tier: "starter", assignedTo: rid }),
            heat({ productId: "i-a", track: "Blue", tier: "intermediate", assignedTo: rid }),
          ]),
        }),
      ],
      [
        member("r1", { isNewRacer: true }),
        member("r2", { isNewRacer: true }),
        member("r3", { isNewRacer: true }), // deselected — no heats
      ],
    );
    const lines = buildRaceChargeLines(session);
    const bundle = lines.find((l) => l.name === getPackage(UQ_ADULT)!.name);
    expect(bundle).toBeDefined();
    expect(bundle!.quantity).toBe(2);
    expect(bundle!.amount).toBeCloseTo(packagePerRacerPrice(getPackage(UQ_ADULT)!) * 2, 2);
    // The deselected heatless racer gets NO license line either.
    expect(lines.some((l) => l.name === "FastTrax License")).toBe(false);
  });

  it("fully-packaged mixed party: no license line, no standalone POV", () => {
    const session = sessionWith(
      [
        raceItem({
          packageIdAdult: UQ_ADULT,
          packageIdJunior: UQ_JUNIOR,
          heats: mixedPackageHeats(),
        }),
      ],
      [member("r1", { isNewRacer: true }), member("r2", { isNewRacer: true, category: "junior" })],
    );
    const lines = buildRaceChargeLines(session);
    expect(lines.some((l) => l.name === "FastTrax License")).toBe(false);
    expect(lines.some((l) => l.name === "POV Race Video")).toBe(false);
    expect(lines).toHaveLength(2); // the two bundle lines only
  });
});
