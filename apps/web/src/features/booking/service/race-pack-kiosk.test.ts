import { describe, expect, it } from "vitest";
import {
  applyPackSelection,
  computePackCoverage,
  coveredMembersPreview,
  kioskPackSkus,
  packSkusForRaceDate,
  resolveKioskPacks,
  resolveSessionPacks,
  type ResolvedKioskPack,
} from "./race-pack-kiosk";
import { getRacePack } from "../data/packs";
import type { RaceHeatAssignment } from "../state/types";

// 2026-07-20 is a Monday (weekday for credit purposes), 2026-07-18 a Saturday.
const MONDAY = "2026-07-20";
const SATURDAY = "2026-07-18";

const member = (
  id: string,
  over: Partial<{
    bmiPersonId: string | null;
    isNewRacer: boolean;
    creditBalances: Array<{ kind: string; balance: number }>;
  }> = {},
) => ({
  id,
  bmiPersonId: `9${id}` as string | null,
  isNewRacer: false,
  ...over,
});

describe("coveredMembersPreview", () => {
  it("covers an in-cart pack holder (new racers included)", () => {
    const covered = coveredMembersPreview(
      { creditPacks: [{ slug: "3-race-anytime", memberId: "m1" }] },
      [member("m1", { isNewRacer: true })],
      MONDAY,
    );
    expect(covered.get("m1")).toEqual({ source: "cart-pack" });
  });

  it("ignores cart packs for members without a BMI account or with a bad slug", () => {
    const covered = coveredMembersPreview(
      {
        creditPacks: [
          { slug: "3-race-anytime", memberId: "m1" },
          { slug: "not-a-pack", memberId: "m2" },
        ],
      },
      [member("m1", { bmiPersonId: null }), member("m2")],
      MONDAY,
    );
    expect(covered.size).toBe(0);
  });

  it("covers a returning racer with credits eligible today", () => {
    const covered = coveredMembersPreview(
      {},
      [member("m1", { creditBalances: [{ kind: "Anytime Race Credit", balance: 2 }] })],
      SATURDAY,
    );
    expect(covered.get("m1")).toEqual({ source: "account-credits", credits: 2 });
  });

  it("day-locks weekday credits: covered Monday, not Saturday", () => {
    const party = [member("m1", { creditBalances: [{ kind: "Weekday Race Credit", balance: 3 }] })];
    expect(coveredMembersPreview({}, party, MONDAY).has("m1")).toBe(true);
    expect(coveredMembersPreview({}, party, SATURDAY).has("m1")).toBe(false);
  });

  it("never counts account credits for a NEW racer (mirrors checkout eligibility)", () => {
    const covered = coveredMembersPreview(
      {},
      [
        member("m1", {
          isNewRacer: true,
          creditBalances: [{ kind: "Anytime Race Credit", balance: 2 }],
        }),
      ],
      MONDAY,
    );
    expect(covered.size).toBe(0);
  });

  it("an in-cart pack wins over account credits (copy names what they just did)", () => {
    const covered = coveredMembersPreview(
      { creditPacks: [{ slug: "3-race-anytime", memberId: "m1" }] },
      [member("m1", { creditBalances: [{ kind: "Anytime Race Credit", balance: 5 }] })],
      MONDAY,
    );
    expect(covered.get("m1")?.source).toBe("cart-pack");
  });

  it("empty inputs → empty map", () => {
    expect(coveredMembersPreview({}, [], MONDAY).size).toBe(0);
  });
});

// ── computePackCoverage backfill (the charge-side rules the preview mirrors) ──

const heat = (
  assignedTo: string,
  heatId: string,
  over: Partial<RaceHeatAssignment> = {},
): RaceHeatAssignment => ({
  productId: "43046468",
  track: "Blue",
  heatId,
  bmiLineId: null,
  assignedTo,
  ...over,
});

const packFor = (memberId: string, slug = "3-race-anytime"): ResolvedKioskPack => {
  const pack = getRacePack(slug)!;
  return {
    slug,
    pack,
    memberId,
    personId: `9${memberId}`,
    memberName: memberId,
    label: pack.name,
    priceCents: Math.round(pack.price * 100),
  };
};

const raceSession = (
  heats: RaceHeatAssignment[],
  over: Partial<{ packageIdAdult: string | null; packageIdJunior: string | null }> = {},
) => ({ items: [{ kind: "race", heats, ...over }] });

describe("computePackCoverage", () => {
  it("covers the assignee's heats up to raceCount, in session order", () => {
    const heats = [heat("m1", "h1"), heat("m1", "h2"), heat("m1", "h3"), heat("m1", "h4")];
    const cov = computePackCoverage(raceSession(heats), [packFor("m1")], new Set());
    expect(cov.usedByMember.get("m1")).toBe(3);
    expect(cov.heats.has(heats[3])).toBe(false);
    expect(cov.redemptions).toHaveLength(3);
    expect(cov.redemptions[0].personId).toBe("9m1");
  });

  it("a bigger pack covers more of today: 4 heats all covered by a 5-pack", () => {
    const heats = [heat("m1", "h1"), heat("m1", "h2"), heat("m1", "h3"), heat("m1", "h4")];
    const cov = computePackCoverage(
      raceSession(heats),
      [packFor("m1", "5-race-anytime")],
      new Set(),
    );
    expect(cov.usedByMember.get("m1")).toBe(4);
    expect(cov.heats.size).toBe(4);
    expect(cov.redemptions).toHaveLength(4);
  });

  it("skips other members, already-redeemed heats, and combo pack products", () => {
    const redeemed = heat("m1", "h2");
    const heats = [
      heat("m2", "h1"),
      redeemed,
      heat("m1", "h3", { productId: "45094787" }), // Pro Mega 3-Pack (combo)
      heat("m1", "h4"),
    ];
    const cov = computePackCoverage(raceSession(heats), [packFor("m1")], new Set([redeemed]));
    expect(cov.heats.size).toBe(1);
    expect(cov.heats.has(heats[3])).toBe(true);
  });

  it("premium package blocks coverage per category only", () => {
    const adult = heat("m1", "h1", { category: "adult" });
    const junior = heat("m2", "h2", { category: "junior" });
    const cov = computePackCoverage(
      raceSession([adult, junior], { packageIdAdult: "ultimate-qualifier-weekday" }),
      [packFor("m1"), packFor("m2")],
      new Set(),
    );
    expect(cov.heats.has(adult)).toBe(false);
    expect(cov.heats.has(junior)).toBe(true);
  });
});

describe("kioskPackSkus", () => {
  it("offers the WHOLE catalog — 3/5/10 × Mon–Thu + Any-Day — smallest first", () => {
    const monday = new Date(2026, 6, 20);
    expect(kioskPackSkus(monday).map((p) => p.slug)).toEqual([
      "3-race-weekday",
      "3-race-anytime",
      "5-race-weekday",
      "5-race-anytime",
      "10-race-weekday",
      "10-race-anytime",
    ]);
  });

  it("hides every Mon–Thu SKU on a weekend day, bigger packs included", () => {
    const saturday = new Date(2026, 6, 18);
    expect(kioskPackSkus(saturday).map((p) => p.slug)).toEqual([
      "3-race-anytime",
      "5-race-anytime",
      "10-race-anytime",
    ]);
  });
});

describe("resolveKioskPacks", () => {
  it("resolves the bigger packs the in-booking teaser now sells (5 and 10)", () => {
    const party = [{ id: "m1", firstName: "Eric", lastName: "O", bmiPersonId: "91" }];
    const monday = new Date(2026, 6, 20);
    expect(
      resolveKioskPacks([{ slug: "5-race-anytime", memberId: "m1" }], party, { now: monday })[0],
    ).toMatchObject({ priceCents: 9999, label: "5-Race Pack (Anytime)" });
    expect(
      resolveKioskPacks([{ slug: "10-race-weekday", memberId: "m1" }], party, { now: monday })[0],
    ).toMatchObject({ priceCents: 15999, label: "10-Race Pack (Mon-Thu)" });
  });

  it("resolves a valid selection and rejects an accountless member", () => {
    const party = [
      { id: "m1", firstName: "Eric", lastName: "O", bmiPersonId: "91" },
      { id: "m2", firstName: "Sam", bmiPersonId: null },
    ];
    const monday = new Date(2026, 6, 20);
    const ok = resolveKioskPacks([{ slug: "3-race-weekday", memberId: "m1" }], party, {
      now: monday,
    });
    expect(ok[0].priceCents).toBe(4999);
    expect(() =>
      resolveKioskPacks([{ slug: "3-race-weekday", memberId: "m2" }], party, { now: monday }),
    ).toThrow(/racer account/);
  });

  it("hides weekday packs on weekend days (day-gated catalog)", () => {
    const party = [{ id: "m1", firstName: "Eric", bmiPersonId: "91" }];
    const saturday = new Date(2026, 6, 18);
    expect(() =>
      resolveKioskPacks([{ slug: "3-race-weekday", memberId: "m1" }], party, { now: saturday }),
    ).toThrow(/isn't available/);
  });
});

describe("packSkusForRaceDate — the day rule keys off the RACE day, not the purchase day", () => {
  // Buying on a Wednesday for a Saturday race: purchase wall-clock says
  // weekday, but the pack's first credit covers the SATURDAY race — the
  // Mon–Thu SKUs must hide.
  const WEDNESDAY_PURCHASE = new Date(2026, 6, 15);
  const SATURDAY_PURCHASE = new Date(2026, 6, 18);

  it("Saturday race bought on a Wednesday → weekday SKUs hidden", () => {
    const slugs = packSkusForRaceDate(SATURDAY, WEDNESDAY_PURCHASE).map((p) => p.slug);
    expect(slugs).toEqual(["3-race-anytime", "5-race-anytime", "10-race-anytime"]);
  });

  it("Monday race bought on a Saturday → weekday SKUs offered", () => {
    const slugs = packSkusForRaceDate(MONDAY, SATURDAY_PURCHASE).map((p) => p.slug);
    expect(slugs).toContain("3-race-weekday");
    expect(slugs).toContain("10-race-weekday");
  });

  // Same DAY rule as the walk-up catalog, not the same CATALOG: mid-sale this
  // list also carries the limited-time SKUs, which the standalone screen never
  // gets (see bogo-sale.test.ts). July is outside every sale window.
  it("no race date yet → wall-clock fallback for the day rule", () => {
    expect(packSkusForRaceDate(null, SATURDAY_PURCHASE).map((p) => p.slug)).toEqual(
      kioskPackSkus(SATURDAY_PURCHASE).map((p) => p.slug),
    );
  });
});

describe("resolveKioskPacks with a race date — fail-closed displayed==charged", () => {
  const party = [{ id: "m1", firstName: "Eric", lastName: "O", bmiPersonId: "91" }];

  it("weekday slug against a weekend race date THROWS at charge time", () => {
    expect(() =>
      resolveKioskPacks([{ slug: "3-race-weekday", memberId: "m1" }], party, {
        raceDate: SATURDAY,
      }),
    ).toThrow(/isn't available/);
  });

  it("weekday slug against a weekday race date resolves — even on a weekend purchase day", () => {
    const saturdayPurchase = new Date(2026, 6, 18);
    const ok = resolveKioskPacks([{ slug: "3-race-weekday", memberId: "m1" }], party, {
      now: saturdayPurchase,
      raceDate: MONDAY,
    });
    expect(ok[0].slug).toBe("3-race-weekday");
  });
});

describe("resolveSessionPacks — per-item resolve against each race's own date", () => {
  const party = [{ id: "m1", firstName: "Eric", lastName: "O", bmiPersonId: "91" }];

  it("resolves each race item's picks with that item's date", () => {
    const session = {
      party,
      items: [
        {
          kind: "race",
          date: MONDAY,
          creditPacks: [{ slug: "3-race-weekday", memberId: "m1" }],
        },
      ],
    };
    expect(resolveSessionPacks(session)[0].slug).toBe("3-race-weekday");
  });

  it("throws when an item's pick no longer fits its date", () => {
    const session = {
      party,
      items: [
        {
          kind: "race",
          date: SATURDAY,
          creditPacks: [{ slug: "3-race-weekday", memberId: "m1" }],
        },
      ],
    };
    expect(() => resolveSessionPacks(session)).toThrow(/isn't available/);
  });

  it("empty picks → empty result, non-race items ignored", () => {
    expect(
      resolveSessionPacks({ party, items: [{ kind: "bowling" }, { kind: "race", date: MONDAY }] }),
    ).toEqual([]);
  });
});

describe("computePackCoverage — weekday pack never covers a weekend-dated item", () => {
  const heat = (assignedTo: string): RaceHeatAssignment =>
    ({
      heatId: "2026-07-18T18:00:00",
      productId: "24953280",
      category: "adult",
      track: "Red",
      assignedTo,
      bmiLineId: null,
    }) as RaceHeatAssignment;

  const weekdayPack: ResolvedKioskPack = {
    slug: "3-race-weekday",
    pack: getRacePack("3-race-weekday")!,
    memberId: "m1",
    personId: "91",
    memberName: "Eric O",
    label: "3-Race Pack (Mon–Thu)",
    priceCents: 4999,
  };

  it("skips heats on a Saturday-dated race item", () => {
    const session = {
      items: [{ kind: "race", date: SATURDAY, heats: [heat("m1")] }],
    };
    const cov = computePackCoverage(session, [weekdayPack], new Set());
    expect(cov.heats.size).toBe(0);
  });

  it("covers heats on a Monday-dated race item", () => {
    const session = {
      items: [{ kind: "race", date: MONDAY, heats: [heat("m1")] }],
    };
    const cov = computePackCoverage(session, [weekdayPack], new Set());
    expect(cov.heats.size).toBe(1);
  });
});

describe("applyPackSelection", () => {
  const WD = "3-race-weekday";
  const ANY = "3-race-anytime";

  it("adds the slug for every checked member in one apply", () => {
    const next = applyPackSelection([], WD, ["m1", "m2", "m3"]);
    expect(next).toEqual([
      { slug: WD, memberId: "m1" },
      { slug: WD, memberId: "m2" },
      { slug: WD, memberId: "m3" },
    ]);
  });

  it("replaces a checked member's other pack (one pack per racer)", () => {
    const next = applyPackSelection([{ slug: ANY, memberId: "m1" }], WD, ["m1", "m2"]);
    expect(next).toEqual([
      { slug: WD, memberId: "m1" },
      { slug: WD, memberId: "m2" },
    ]);
  });

  it("unchecking a current holder removes their pack; other slugs untouched", () => {
    const picks = [
      { slug: WD, memberId: "m1" },
      { slug: WD, memberId: "m2" },
      { slug: ANY, memberId: "m3" },
    ];
    // m2 unchecked from the weekday pack's panel — m3's any-day pack survives.
    const next = applyPackSelection(picks, WD, ["m1"]);
    expect(next).toEqual([
      { slug: ANY, memberId: "m3" },
      { slug: WD, memberId: "m1" },
    ]);
  });

  it("returns undefined when the result is empty (session stores no key)", () => {
    expect(applyPackSelection([{ slug: WD, memberId: "m1" }], WD, [])).toBeUndefined();
  });
});
