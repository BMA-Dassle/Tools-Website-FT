import { describe, expect, it } from "vitest";
import {
  computePackCoverage,
  coveredMembersPreview,
  resolveKioskPacks,
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

describe("resolveKioskPacks", () => {
  it("resolves a valid selection and rejects an accountless member", () => {
    const party = [
      { id: "m1", firstName: "Eric", lastName: "O", bmiPersonId: "91" },
      { id: "m2", firstName: "Sam", bmiPersonId: null },
    ];
    const monday = new Date(2026, 6, 20);
    const ok = resolveKioskPacks([{ slug: "3-race-weekday", memberId: "m1" }], party, monday);
    expect(ok[0].priceCents).toBe(4999);
    expect(() =>
      resolveKioskPacks([{ slug: "3-race-weekday", memberId: "m2" }], party, monday),
    ).toThrow(/racer account/);
  });

  it("hides weekday packs on weekend days (day-gated catalog)", () => {
    const party = [{ id: "m1", firstName: "Eric", bmiPersonId: "91" }];
    const saturday = new Date(2026, 6, 18);
    expect(() =>
      resolveKioskPacks([{ slug: "3-race-weekday", memberId: "m1" }], party, saturday),
    ).toThrow(/isn't available/);
  });
});
