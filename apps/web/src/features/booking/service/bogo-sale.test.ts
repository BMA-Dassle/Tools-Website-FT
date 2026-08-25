/**
 * BOGO races — a recurring WEDNESDAY promo (owner 2026-08-19; it ran 2026-08-12
 * → EOD 2026-08-13 as a one-off flash sale before that).
 *
 * The promo ships as TWO instruments in two different registries — a credit pack
 * for returning racers and a package for new ones — so most of what can go
 * wrong here is the two halves DISAGREEING. These tests pin the agreements.
 *
 * The day rule keys off the RACE DATE, not the purchase instant: "BOGO
 * Wednesdays" has to reach a guest booking on Tuesday for a Wednesday race, and
 * must not reach a Wednesday walk-up booking Thursday. Almost every test below
 * therefore fixes BOTH a race date and a `now`.
 */
import { describe, it, expect } from "vitest";
import {
  RACE_PACKS,
  BOGO_SALE_RULE,
  BOGO_SALE_SLUGS,
  bogoSaleActive,
  getRacePack,
  racePackLabel,
} from "../data/packs";
import {
  kioskPackSkus,
  packSkusForRaceDate,
  resolveKioskPacks,
  webPackSkus,
} from "./race-pack-kiosk";
import {
  packFitsMember,
  promotedSaleSku,
} from "~/components/features/booking/steps/race/RacePackPicker";
import {
  eligiblePackages,
  getPackage,
  packageFitsRaceDate,
  packagePerRacerPrice,
} from "@/lib/packages";

/** Race dates. 8/19 is the promo's first Wednesday; 9/16 is a later one. */
const WED = "2026-08-19";
const LATER_WED = "2026-09-16";
const THU = "2026-08-20";
const TUE = "2026-08-18";
const MON = "2026-08-24";
const SAT = "2026-08-22";

/** Purchase instants. TUE_BUYS is the one race-date keying exists for. */
const WED_BUYS = new Date("2026-08-19T18:00:00-04:00");
const TUE_BUYS = new Date("2026-08-18T18:00:00-04:00");
const LATER_BUYS = new Date("2026-09-15T18:00:00-04:00");
/** An off-promo weekday and a weekend day, for the clock-free web catalog. */
const MON_BUYS = new Date("2026-08-24T18:00:00-04:00");
const SAT_BUYS = new Date("2026-08-22T18:00:00-04:00");
/** Before the promo existed — the floor that stops a recurring rule reaching back. */
const BEFORE = new Date("2026-07-15T18:00:00-04:00");

const BOGO_PACKAGE_IDS = ["bogo-weekday", "bogo-weekday-junior"] as const;

describe("BOGO — the two halves run on the same days", () => {
  /**
   * THE pin. One advertised promo cannot have its credit-pack half running on
   * different days from its package half: a guest who sees "every Wednesday" on
   * one screen and finds the other selling on Thursday is a refund conversation.
   * The rule is declared in two files (lib/packages.ts can't import from
   * features/), so nothing but this test keeps them equal.
   */
  it("every BOGO package carries exactly BOGO_SALE_RULE", () => {
    for (const id of BOGO_PACKAGE_IDS) {
      expect(getPackage(id)?.raceDays).toEqual(BOGO_SALE_RULE);
    }
  });

  it("the rule is Wednesdays, from 2026-08-19", () => {
    expect(BOGO_SALE_RULE).toEqual({ days: [3], from: "2026-08-19" }); // 3 = Wednesday
  });

  /**
   * The promo is open-ended, and `raceDays.from` is the ONLY floor — deliberately
   * not doubled up with a `bookableFrom`, which bounds the PURCHASE clock and
   * would refuse the very case race-date keying exists for.
   */
  it("neither half has a purchase window any more", () => {
    for (const id of BOGO_PACKAGE_IDS) {
      expect(getPackage(id)?.bookableUntil).toBeUndefined();
      expect(getPackage(id)?.bookableFrom).toBeUndefined();
    }
    // A Wednesday months out still sells, at a purchase instant months out.
    expect(bogoSaleActive(LATER_WED, LATER_BUYS)).toBe(true);
    expect(
      eligiblePackages({
        racerType: "new",
        schedule: "weekday",
        category: "adult",
        raceDate: LATER_WED,
        now: LATER_BUYS,
      }).map((p) => p.id),
    ).toContain("bogo-weekday");
  });
});

describe("BOGO — the day rule reads the RACE date, not the purchase day", () => {
  it("a Wednesday race is on, whatever day it was booked", () => {
    expect(bogoSaleActive(WED, WED_BUYS)).toBe(true);
    // The case race-date keying exists for: booked Tuesday, raced Wednesday.
    expect(bogoSaleActive(WED, TUE_BUYS)).toBe(true);
  });

  it("a non-Wednesday race is off, even bought on a Wednesday", () => {
    for (const date of [MON, TUE, THU, SAT]) {
      expect(bogoSaleActive(date, WED_BUYS)).toBe(false);
    }
  });

  /**
   * The floor lands on whichever day the rule reads — the RACE date when there is
   * one. Flooring the purchase clock instead would leave a Wednesday race date
   * from BEFORE the promo reading as active for anyone asking today, which is the
   * regression that once put sale SKUs in the catalog for a July race date.
   */
  it("a race date before the promo started is off, Wednesday or not", () => {
    // 2026-07-15 is itself a Wednesday — the floor is what refuses it, and it
    // stays refused no matter when the question is asked.
    expect(bogoSaleActive("2026-07-15", BEFORE)).toBe(false);
    expect(bogoSaleActive("2026-07-15", WED_BUYS)).toBe(false);
    expect(bogoSaleActive("2026-07-15", LATER_BUYS)).toBe(false);
    // ...and the walk-up fallback floors the clock the same way.
    expect(bogoSaleActive(null, BEFORE)).toBe(false);
  });

  /** Launch day itself: bought the evening before, raced on the first Wednesday. */
  it("the promo's own first day is on, including for a booking made the day before", () => {
    expect(bogoSaleActive(WED, TUE_BUYS)).toBe(true);
  });

  /**
   * No race date = the standalone walk-up rail, where purchase day IS race day.
   * The fallback must read EASTERN time: Vercel runs UTC, so 9pm Wednesday ET is
   * already Thursday to `getDay()` and the promo would darken four hours early
   * every week.
   */
  it("no race date falls back to the ET wall clock, not the server's day", () => {
    expect(bogoSaleActive(null, WED_BUYS)).toBe(true);
    expect(bogoSaleActive(null, TUE_BUYS)).toBe(false);
    // 2026-08-19T21:30 ET == 2026-08-20T01:30 UTC. Still Wednesday in Fort Myers.
    expect(bogoSaleActive(null, new Date("2026-08-20T01:30:00Z"))).toBe(true);
    // And 2026-08-19T23:30 ET == 2026-08-20T03:30 UTC — the last ET half hour.
    expect(bogoSaleActive(null, new Date("2026-08-20T03:30:00Z"))).toBe(true);
    // 2026-08-20T00:30 ET == 04:30 UTC — Thursday in Fort Myers, so off.
    expect(bogoSaleActive(null, new Date("2026-08-20T04:30:00Z"))).toBe(false);
  });

  /**
   * A `YYYY-MM-DD` race date must be parsed LOCAL, not UTC:
   * `new Date("2026-08-19")` is UTC midnight, which is Tuesday 8pm in ET and
   * would read the day BEFORE. That bug once hid a package for a whole Tuesday.
   */
  it("a YYYY-MM-DD race date is parsed local, so Wednesday isn't read as Tuesday", () => {
    expect(bogoSaleActive("2026-08-19", WED_BUYS)).toBe(true);
    expect(bogoSaleActive("2026-08-19T14:00:00", WED_BUYS)).toBe(true);
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

  /**
   * The free credit stays on the Mon–Thu deposit kind even though the promo is
   * Wednesday-only. Pandora has no Wednesday-only kind, and a credit good on any
   * Mon–Thu visit is MORE generous than advertised — the safe direction. Pinning
   * it stops someone "tidying" this into a narrower kind that would refuse a
   * guest at redemption.
   */
  it("the free race is weekday-locked and costs no license or POV", () => {
    for (const slug of BOGO_SALE_SLUGS) {
      // 12744867 = the Mon–Thu "Weekday Race Credit" kind (data/race-credits.ts).
      expect(getRacePack(slug)!.depositKindId).toBe("12744867");
    }
    for (const id of BOGO_PACKAGE_IDS) {
      const pkg = getPackage(id)!;
      // `schedules` is the PRICING TIER of the component SKUs and stays weekday;
      // `raceDays` narrows within it. Dropping the tier would offer
      // weekday-priced products against a weekend heat grid.
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
      raceDate: WED,
      now: WED_BUYS,
    });
    expect(offered.filter((p) => p.badge)).toHaveLength(0);
  });
});

describe("BOGO — the day rule is enforced server-side, not just hidden", () => {
  const ctx = { racerType: "new", schedule: "weekday", category: "adult" } as const;

  it("packages are offered for a Wednesday race and not for a Thursday one", () => {
    expect(eligiblePackages({ ...ctx, raceDate: WED, now: TUE_BUYS }).map((p) => p.id)).toContain(
      "bogo-weekday",
    );
    expect(
      eligiblePackages({ ...ctx, raceDate: THU, now: WED_BUYS }).map((p) => p.id),
    ).not.toContain("bogo-weekday");
    expect(
      eligiblePackages({ ...ctx, raceDate: MON, now: WED_BUYS }).map((p) => p.id),
    ).not.toContain("bogo-weekday");
  });

  it("credit-pack slugs are in the offered catalog only on the promo's days", () => {
    expect(packSkusForRaceDate(WED, TUE_BUYS).map((p) => p.slug)).toEqual(
      expect.arrayContaining([...BOGO_SALE_SLUGS]),
    );
    const thursday = packSkusForRaceDate(THU, WED_BUYS).map((p) => p.slug);
    for (const slug of BOGO_SALE_SLUGS) expect(thursday).not.toContain(slug);
  });

  it("resolveKioskPacks REFUSES a BOGO slug for an off-day race, not just hides it", () => {
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
        now: WED_BUYS,
        raceDate: THU,
      }),
    ).toThrow(/isn't available/i);
    // Same slug, same purchase instant, Wednesday race → sells.
    expect(() =>
      resolveKioskPacks([{ slug: "bogo-races-adult", memberId: "m1" }], party, {
        now: WED_BUYS,
        raceDate: WED,
      }),
    ).not.toThrow();
  });

  /**
   * `packageFitsRaceDate` is also the reducer's invalidation rule when a guest
   * moves their date (features/booking/state/machine.ts), which is the only
   * fail-safe available: the charge path resolves packages by id through
   * `getPackage`, deliberately NOT day-gated.
   */
  it("packageFitsRaceDate leaves every standing bundle alone", () => {
    for (const day of [WED, THU, SAT]) {
      expect(packageFitsRaceDate(getPackage("ultimate-qualifier-weekday")!, day)).toBe(true);
      expect(packageFitsRaceDate(getPackage("rookie-pack-weekday")!, day)).toBe(true);
      expect(packageFitsRaceDate(getPackage("ultimate-qualifier-weekend")!, day)).toBe(true);
    }
    expect(packageFitsRaceDate(getPackage("bogo-weekday")!, WED)).toBe(true);
    expect(packageFitsRaceDate(getPackage("bogo-weekday")!, THU)).toBe(false);
  });
});

/**
 * The pay-mode page renders once PER CATEGORY and promotes one limited-time SKU
 * out of the collapsed Race Packs line. That row auto-applies the pack when a
 * single racer fits it, so promoting the wrong tier's SKU is a mis-assignment,
 * not just a cosmetic price. Making BOGO weekly turns this from a two-day
 * exposure into every Wednesday, which is why it is pinned here.
 */
describe("BOGO — the promoted row leads with the page's OWN tier", () => {
  const adult = { id: "a1", firstName: "Dale", category: "adult" as const, isNewRacer: false };
  const junior = { id: "j1", firstName: "Suzy", category: "junior" as const, isNewRacer: false };
  const mixed = [adult, junior];
  const skus = packSkusForRaceDate(WED, WED_BUYS);

  it("a mixed party's ADULT page promotes the adult SKU, not the cheaper junior one", () => {
    // The bug this pins: junior $15.99 < adult $20.99, so the junior SKU used to
    // win the "cheapest" reduce on BOTH pages. An adult tapping that row put a
    // junior pack on the kid and nothing on themselves.
    const lead = promotedSaleSku(skus, mixed, "adult");
    expect(lead?.slug).toBe("bogo-races-adult");
    expect(lead?.price).toBe(20.99);
  });

  it("the same party's JUNIOR page promotes the junior SKU", () => {
    const lead = promotedSaleSku(skus, mixed, "junior");
    expect(lead?.slug).toBe("bogo-races-junior");
    expect(lead?.price).toBe(15.99);
  });

  it("the promoted SKU can only land on racers the page is for", () => {
    for (const category of ["adult", "junior"] as const) {
      const lead = promotedSaleSku(skus, mixed, category)!;
      const fits = mixed.filter((m) => packFitsMember(lead, m));
      expect(fits.map((m) => m.category)).toEqual([category]);
    }
  });

  it("a party with nobody eligible for the promo gets no row", () => {
    const rookies = [{ ...adult, isNewRacer: true }];
    // Credit packs are returning-racer-only; a first-timer gets the PACKAGE.
    expect(promotedSaleSku(skus, rookies, "adult")).toBeNull();
    // An all-adult party never leads with the junior SKU either.
    expect(promotedSaleSku(skus, [adult], "junior")).toBeNull();
  });

  it("off a promo day there is nothing to promote at all", () => {
    const thursday = packSkusForRaceDate(THU, WED_BUYS);
    expect(promotedSaleSku(thursday, mixed, "adult")).toBeNull();
    expect(promotedSaleSku(thursday, mixed, "junior")).toBeNull();
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
  const opts = { now: WED_BUYS, raceDate: WED };

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
  /**
   * The LABEL still says Mon–Thu, and that is correct: it describes when the
   * granted CREDITS are valid (the Mon–Thu deposit kind), not when the promo
   * runs. Narrowing it to "Wed" would misstate a credit that really is good all
   * week — the direction a discount must never lean.
   */
  it("labels name the tier, so the Square line and ledger row differ", () => {
    expect(racePackLabel(getRacePack("bogo-races-adult")!)).toBe("BOGO Races (Mon-Thu)");
    expect(racePackLabel(getRacePack("bogo-races-junior")!)).toBe("BOGO Races Junior (Mon-Thu)");
  });

  it("standing pack labels are unchanged", () => {
    expect(racePackLabel(getRacePack("5-race-weekday")!)).toBe("5-Race Pack (Mon-Thu)");
    expect(racePackLabel(getRacePack("10-race-anytime")!)).toBe("10-Race Pack (Anytime)");
  });

  it("the promo adds exactly two SKUs and repriced nothing else", () => {
    const sale = RACE_PACKS.filter((p) => p.badge);
    expect(sale.map((p) => p.slug).sort()).toEqual([...BOGO_SALE_SLUGS].sort());
    // The standing catalog's prices are load-bearing for the pack ladder.
    expect(getRacePack("3-race-weekday")!.price).toBe(49.99);
    expect(getRacePack("5-race-weekday")!.price).toBe(79.99);
    expect(getRacePack("10-race-weekday")!.price).toBe(159.99);
  });

  it("a weekend race date still hides Mon–Thu SKUs, promo included", () => {
    const sat = packSkusForRaceDate(SAT, WED_BUYS).map((p) => p.slug);
    for (const slug of BOGO_SALE_SLUGS) expect(sat).not.toContain(slug);
    expect(sat).not.toContain("5-race-weekday");
  });
});

/**
 * The standalone attract-screen flow lists every offered SKU per racer with NO
 * eligibility filter and no tier marker, so a tier-priced SKU has nothing there
 * to hold it to its tier. Live 2026-08-13 that showed juniors two identical
 * "2 RACES / Mon–Thu" tiles: tapping the adult one CHARGED them $20.99 (their
 * SKU is $15.99), tapping their own dead-ended at prepare. Owner: BOGO does not
 * belong on that screen. Making the promo weekly does not change that — it puts
 * the same trap in front of guests every Wednesday instead of once.
 */
describe("BOGO — never on the standalone walk-up screen", () => {
  it("the standalone catalog is the standing six, promo day or not", () => {
    const onPromoDay = kioskPackSkus(WED_BUYS).map((p) => p.slug);
    expect(onPromoDay).toEqual([
      "3-race-weekday",
      "3-race-anytime",
      "5-race-weekday",
      "5-race-anytime",
      "10-race-weekday",
      "10-race-anytime",
    ]);
    for (const slug of BOGO_SALE_SLUGS) expect(onPromoDay).not.toContain(slug);
  });

  it("no tier- or history-restricted SKU can ever reach that screen", () => {
    // The durable guard: the next limited-time SKU won't be called BOGO, and
    // the screen still has no filter. Anything carrying a restriction has no
    // business in this catalog.
    for (const p of kioskPackSkus(WED_BUYS)) {
      expect(p.category).toBeUndefined();
      expect(p.racerType).toBeUndefined();
    }
  });

  it("the in-booking catalog still carries the promo on the same instant", () => {
    // The fix must not have darkened the promo where it IS sold — the pay-mode
    // page is per category and its picker filters by racer.
    expect(packSkusForRaceDate(WED, WED_BUYS).map((p) => p.slug)).toEqual(
      expect.arrayContaining([...BOGO_SALE_SLUGS]),
    );
  });

  it("the resolver REFUSES a BOGO slug on the standalone rail on a promo day", () => {
    // Fail-closed, not merely hidden: a kiosk left on a cached build (or a
    // hand-rolled POST) still names the slug, and prepare is where money starts.
    const party = [
      {
        id: "123456789012345678",
        firstName: "Suzy",
        bmiPersonId: "123456789012345678",
        category: "junior" as const,
        isNewRacer: false,
      },
    ];
    for (const slug of BOGO_SALE_SLUGS) {
      expect(() =>
        resolveKioskPacks([{ slug, memberId: "123456789012345678" }], party, {
          now: WED_BUYS,
          surface: "standalone",
        }),
      ).toThrow(/isn't available/i);
    }
  });

  it("the standing packs still sell on the standalone rail on a promo day", () => {
    const party = [
      {
        id: "123456789012345678",
        firstName: "Newt",
        bmiPersonId: "123456789012345678",
        category: "adult" as const,
        isNewRacer: true,
      },
    ];
    const resolved = resolveKioskPacks(
      [{ slug: "5-race-weekday", memberId: "123456789012345678" }],
      party,
      { now: WED_BUYS, surface: "standalone" },
    );
    expect(resolved[0].priceCents).toBe(7999);
  });
});

/**
 * The WEB race-pack page (`/book/race-pack/v2`) is the SECOND screen with no
 * tier, and it was missed when the kiosk one was fixed on 2026-08-13: it
 * rendered the raw `RACE_PACKS` array, so it showed BOGO tiles every day —
 * ignoring even the promo's own day rule — and its own review step never asks a
 * racer's category. Owner 2026-08-25: the BOGOs do not belong on this page.
 *
 * Worse there than on the kiosk: that rail charges the tile's own price through
 * `/api/square/pay` and grants `raceCount` credits directly, so it has no
 * `resolveKioskPacks` step to fail closed behind the UI. On this one surface the
 * catalog accessor IS the enforcement point — which is exactly why the page must
 * never reach past it to the raw array.
 */
describe("BOGO — never on the web race-pack page", () => {
  it("the web catalog is the standing six, promo day or not", () => {
    const slugs = webPackSkus().map((p) => p.slug);
    expect(slugs).toEqual([
      "3-race-weekday",
      "3-race-anytime",
      "5-race-weekday",
      "5-race-anytime",
      "10-race-weekday",
      "10-race-anytime",
    ]);
    for (const slug of BOGO_SALE_SLUGS) expect(slugs).not.toContain(slug);
  });

  it("no tier- or history-restricted SKU can ever reach that page", () => {
    // The durable guard, same as the standalone screen's: the next limited-time
    // SKU won't be called BOGO, and this page still has no tier to check it.
    for (const p of webPackSkus()) {
      expect(p.category).toBeUndefined();
      expect(p.racerType).toBeUndefined();
    }
  });

  it("reads no clock — the catalog cannot differ between promo day and any other", () => {
    // Deliberately clock-free, unlike the other two accessors: this page books
    // no race, and it renders inside a "use client" component that is also
    // server-rendered, where a date-dependent catalog is a hydration mismatch
    // waiting for a midnight or Thu→Fri boundary.
    expect(webPackSkus().map((p) => p.slug)).toEqual(kioskPackSkus(MON_BUYS).map((p) => p.slug));
    expect(bogoSaleActive(WED, WED_BUYS)).toBe(true); // promo IS live at that instant…
    expect(webPackSkus().some((p) => p.badge)).toBe(false); // …and still not on this page
  });

  it("keeps every Mon–Thu pack on a weekend, unlike the walk-up screen", () => {
    // v1 `/book/race-packs` parity. The Fri–Sun hiding exists because the
    // pack's FIRST CREDIT covers the race being booked; this page books no
    // race and its credits never expire, so hiding half the catalog every
    // weekend would just refuse a Saturday buyer the pack for their Monday
    // visit. The Mon–Thu limit is disclosed on the review step instead.
    const weekendWalkUp = kioskPackSkus(SAT_BUYS).map((p) => p.slug);
    expect(weekendWalkUp).not.toContain("3-race-weekday");
    expect(webPackSkus().map((p) => p.slug)).toContain("3-race-weekday");
  });
});
