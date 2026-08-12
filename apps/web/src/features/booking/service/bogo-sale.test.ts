/**
 * BOGO flash sale (2026-08-12 → EOD 2026-08-13).
 *
 * The sale ships as TWO instruments in two different registries — a credit pack
 * for returning racers and a package for new ones — so most of what can go
 * wrong here is the two halves DISAGREEING. These tests pin the agreements.
 */
import { describe, it, expect } from "vitest";
import {
  RACE_PACKS,
  BOGO_SALE_ENDS_AT,
  BOGO_SALE_SLUGS,
  bogoSaleActive,
  getRacePack,
  racePackLabel,
} from "../data/packs";
import { kioskPackSkus, packSkusForRaceDate, resolveKioskPacks } from "./race-pack-kiosk";
import { eligiblePackages, getPackage, packagePerRacerPrice } from "@/lib/packages";

/** Wed 2026-08-12 and Thu 2026-08-13 are both weekday-schedule sale days. */
const DURING = new Date("2026-08-12T18:00:00-04:00");
const LAST_SECOND = new Date("2026-08-13T23:59:59-04:00");
const AFTER = new Date("2026-08-14T00:00:01-04:00");

const BOGO_PACKAGE_IDS = ["bogo-weekday", "bogo-weekday-junior"] as const;

describe("BOGO — the two halves end together", () => {
  /**
   * THE pin. One advertised sale cannot have its credit-pack half outlive its
   * package half: a guest who sees "today & tomorrow" on one screen and finds
   * the other still selling on 8/14 is a refund conversation. The constants
   * live in different files (lib/packages.ts can't import from features/), so
   * nothing but this test keeps them equal.
   */
  it("every BOGO package expires at exactly BOGO_SALE_ENDS_AT", () => {
    for (const id of BOGO_PACKAGE_IDS) {
      expect(getPackage(id)?.bookableUntil).toBe(BOGO_SALE_ENDS_AT);
    }
  });

  it("the sale window is the owner's 8/12 → EOD 8/13", () => {
    expect(BOGO_SALE_ENDS_AT).toBe("2026-08-13T23:59:59");
    expect(bogoSaleActive(DURING)).toBe(true);
    expect(bogoSaleActive(LAST_SECOND)).toBe(true);
    expect(bogoSaleActive(AFTER)).toBe(false);
  });
});

describe("BOGO — savings are half the two-race total, on every SKU", () => {
  /**
   * "Buy one get one" means the saving IS the price of the free race — i.e.
   * exactly half the two-race total (owner). Overstating a discount is the one
   * thing the sell surfaces must never do, and the junior package is the SKU
   * that drifts: its Intermediate component genuinely lists at $20.99, so an
   * auto-summed retail would advertise $20.99 off a $15.99 deal.
   */
  it("credit packs: regularPrice is exactly 2× the charged price", () => {
    for (const slug of BOGO_SALE_SLUGS) {
      const pack = getRacePack(slug)!;
      expect(pack.raceCount).toBe(2);
      expect(pack.regularPrice).toBeCloseTo(pack.price * 2, 2);
    }
  });

  it("packages: retailPrice is exactly 2× the charged price", () => {
    for (const id of BOGO_PACKAGE_IDS) {
      const pkg = getPackage(id)!;
      expect(pkg.races).toHaveLength(2);
      expect(pkg.retailPrice).toBeCloseTo(pkg.price! * 2, 2);
    }
  });

  it("packages charge the pinned price, never the auto-summed component total", () => {
    // Without an explicit `price` the helper sums the components — $41.98 adult,
    // $36.98 junior — i.e. it would charge full freight for the deal.
    expect(packagePerRacerPrice(getPackage("bogo-weekday")!)).toBeCloseTo(20.99, 2);
    expect(packagePerRacerPrice(getPackage("bogo-weekday-junior")!)).toBeCloseTo(15.99, 2);
  });

  it("the free race is weekday-locked and costs no license or POV", () => {
    for (const slug of BOGO_SALE_SLUGS) {
      // 12744867 = the Mon–Thu "Weekday Race Credit" kind (data/race-credits.ts).
      expect(getRacePack(slug)!.depositKindId).toBe("12744867");
    }
    for (const id of BOGO_PACKAGE_IDS) {
      const pkg = getPackage(id)!;
      expect(pkg.schedules).toEqual(["weekday"]);
      expect(pkg.includesLicense).toBe(false);
      expect(pkg.includesPov).toBe(false);
      expect(pkg.appetizerCode).toBeUndefined();
    }
  });
});

describe("BOGO — a racer is never offered both halves", () => {
  /**
   * The split is the whole design: a credit cannot be redeemed by someone who
   * is still flagged a new racer, and a package that exists to EARN the
   * Intermediate unlock is pointless for someone who already holds it.
   */
  it("packages are new-racer-only and Starter-tier-only", () => {
    for (const id of BOGO_PACKAGE_IDS) {
      expect(getPackage(id)?.racerType).toBe("new");
      expect(getPackage(id)?.maxQualifiedTier).toBe("starter");
    }
  });

  it("credit packs are returning-racer-only", () => {
    for (const slug of BOGO_SALE_SLUGS) {
      expect(getRacePack(slug)?.racerType).toBe("existing");
    }
  });

  it("a racer already qualified past Starter is offered no BOGO package", () => {
    const offered = eligiblePackages({
      racerType: "new",
      schedule: "weekday",
      category: "adult",
      qualifiedTier: "intermediate",
      now: DURING,
    });
    expect(offered.filter((p) => p.badge)).toHaveLength(0);
  });
});

describe("BOGO — the window is enforced server-side, not just hidden", () => {
  it("packages stop being offered the instant the window closes", () => {
    const ctx = { racerType: "new", schedule: "weekday", category: "adult" } as const;
    expect(eligiblePackages({ ...ctx, now: DURING }).map((p) => p.id)).toContain("bogo-weekday");
    expect(eligiblePackages({ ...ctx, now: LAST_SECOND }).map((p) => p.id)).toContain(
      "bogo-weekday",
    );
    expect(eligiblePackages({ ...ctx, now: AFTER }).map((p) => p.id)).not.toContain("bogo-weekday");
  });

  it("credit-pack slugs leave the offered catalog when the sale ends", () => {
    expect(kioskPackSkus(DURING).map((p) => p.slug)).toEqual(
      expect.arrayContaining([...BOGO_SALE_SLUGS]),
    );
    const after = kioskPackSkus(AFTER).map((p) => p.slug);
    for (const slug of BOGO_SALE_SLUGS) expect(after).not.toContain(slug);
  });

  it("resolveKioskPacks REFUSES a BOGO slug after the sale, not just hides it", () => {
    // The session carries slug pointers only, so a cached screen or a forged
    // POST is the real threat model — the resolver is the enforcement point.
    const party = [
      {
        id: "m1",
        firstName: "Dale",
        bmiPersonId: "123456789012345678",
        category: "adult" as const,
        isNewRacer: false,
      },
    ];
    expect(() =>
      resolveKioskPacks([{ slug: "bogo-races-adult", memberId: "m1" }], party, {
        now: AFTER,
        raceDate: "2026-08-14",
      }),
    ).toThrow(/isn't available/i);
  });
});

describe("BOGO — tier and history fail closed in the resolver", () => {
  const adult = {
    id: "a1",
    firstName: "Dale",
    bmiPersonId: "123456789012345678",
    category: "adult" as const,
    isNewRacer: false,
  };
  const junior = {
    id: "j1",
    firstName: "Suzy",
    bmiPersonId: "123456789012345679",
    category: "junior" as const,
    isNewRacer: false,
  };
  const rookie = { ...adult, id: "n1", firstName: "Newt", isNewRacer: true };
  const opts = { now: DURING, raceDate: "2026-08-12" };

  it("an adult cannot buy the cheaper junior SKU", () => {
    expect(() =>
      resolveKioskPacks([{ slug: "bogo-races-junior", memberId: "a1" }], [adult], opts),
    ).toThrow(/junior racers/i);
  });

  it("a junior cannot be charged the adult SKU", () => {
    expect(() =>
      resolveKioskPacks([{ slug: "bogo-races-junior", memberId: "j1" }], [junior], opts),
    ).not.toThrow();
    expect(() =>
      resolveKioskPacks([{ slug: "bogo-races-adult", memberId: "j1" }], [junior], opts),
    ).toThrow(/adult racers/i);
  });

  it("a first-time racer cannot buy the returning-only credit pack", () => {
    expect(() =>
      resolveKioskPacks([{ slug: "bogo-races-adult", memberId: "n1" }], [rookie], opts),
    ).toThrow(/returning racers/i);
  });

  it("standing 3/5/10 packs are unrestricted — no regression", () => {
    for (const slug of ["3-race-weekday", "5-race-weekday", "10-race-weekday"]) {
      expect(() => resolveKioskPacks([{ slug, memberId: "n1" }], [rookie], opts)).not.toThrow();
    }
  });
});

describe("BOGO — the two SKUs stay distinguishable in the books", () => {
  it("labels name the tier, so the Square line and ledger row differ", () => {
    expect(racePackLabel(getRacePack("bogo-races-adult")!)).toBe("BOGO Races (Mon-Thu)");
    expect(racePackLabel(getRacePack("bogo-races-junior")!)).toBe("BOGO Races Junior (Mon-Thu)");
  });

  it("standing pack labels are unchanged", () => {
    expect(racePackLabel(getRacePack("5-race-weekday")!)).toBe("5-Race Pack (Mon-Thu)");
    expect(racePackLabel(getRacePack("10-race-anytime")!)).toBe("10-Race Pack (Anytime)");
  });

  it("the sale adds exactly two SKUs and repriced nothing else", () => {
    const sale = RACE_PACKS.filter((p) => p.badge);
    expect(sale.map((p) => p.slug).sort()).toEqual([...BOGO_SALE_SLUGS].sort());
    // The standing catalog's prices are load-bearing for the pack ladder.
    expect(getRacePack("3-race-weekday")!.price).toBe(49.99);
    expect(getRacePack("5-race-weekday")!.price).toBe(79.99);
    expect(getRacePack("10-race-weekday")!.price).toBe(159.99);
  });

  it("a weekend race date still hides Mon–Thu SKUs, sale included", () => {
    const sat = packSkusForRaceDate("2026-08-15", DURING).map((p) => p.slug);
    for (const slug of BOGO_SALE_SLUGS) expect(sat).not.toContain(slug);
  });
});
