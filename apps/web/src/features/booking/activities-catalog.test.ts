import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  allOfferings,
  crossSellFor,
  effectiveBrand,
  findOffering,
  initialOfferingsFor,
  isOfferingInPromoScope,
  landingOfferingsFor,
  offeringsAt,
  squareBookingActivity,
} from "./activities-catalog";
import { addDaysYmd, KBF_PROGRAM_END_YMD, KBF_PROGRAM_START_YMD } from "@/lib/kbf-schedule";
import { emptySession, newItem } from "./state/types";
import type { BookingSession, AttractionItem } from "./state/types";
import type { AppliedPromo } from "~/features/discount-codes";

/**
 * The catalog now has a seasonal offering (kbf), so "what's in the catalog"
 * depends on the date. Pin the clock for the whole file rather than letting
 * these assertions quietly change meaning every September.
 *
 * Both anchors are DERIVED from the schedule constants, so moving the program
 * to a new year moves the tests with it — a hardcoded 2026 date would turn
 * into a false failure the moment someone opens next season.
 */
/** 15:00Z ≈ 11am ET on the program's opening day — unambiguously in season. */
const IN_SEASON = new Date(`${KBF_PROGRAM_START_YMD}T15:00:00Z`);
/** The morning after the program closes — the state this repo is in today. */
const OFF_SEASON = new Date(`${addDaysYmd(KBF_PROGRAM_END_YMD, 1)}T15:00:00Z`);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(IN_SEASON);
});

afterEach(() => {
  vi.useRealTimers();
});

function sessionWithItems(args: {
  center?: BookingSession["center"];
  entryBrand?: BookingSession["entryBrand"];
  items?: BookingSession["items"];
}): BookingSession {
  const s = emptySession({ entryBrand: args.entryBrand ?? "fasttrax" });
  return {
    ...s,
    center: args.center ?? null,
    items: args.items ?? [],
  };
}

describe("activities-catalog", () => {
  describe("findOffering", () => {
    it("returns the offering for a known slug", () => {
      expect(findOffering("race")?.kind).toBe("race");
      expect(findOffering("bowling")?.kind).toBe("bowling");
      expect(findOffering("gel-blaster")?.kind).toBe("attraction");
      expect(findOffering("shuffly")?.attractionSlug).toBe("shuffly");
    });

    it("returns undefined for an unknown slug", () => {
      expect(findOffering("race-pack")).toBeUndefined();
      expect(findOffering("nonsense")).toBeUndefined();
    });
  });

  describe("offeringsAt", () => {
    it("Fort Myers includes racing, duckpin, shuffly, bowling, kbf, gel-blaster, laser-tag", () => {
      const slugs = offeringsAt("fort-myers").map((o) => o.slug);
      expect(slugs).toEqual(
        expect.arrayContaining([
          "race",
          "duck-pin",
          "shuffly",
          "bowling",
          "kbf",
          "gel-blaster",
          "laser-tag",
        ]),
      );
    });

    it("Naples excludes FT-only offerings (race, duck-pin, shuffly)", () => {
      const slugs = offeringsAt("naples").map((o) => o.slug);
      expect(slugs).not.toContain("race");
      expect(slugs).not.toContain("duck-pin");
      expect(slugs).not.toContain("shuffly");
      expect(slugs).toEqual(expect.arrayContaining(["bowling", "kbf", "gel-blaster", "laser-tag"]));
    });
  });

  describe("crossSellFor", () => {
    it("returns every offering when the session has no items and no center yet", () => {
      const session = sessionWithItems({});
      expect(
        crossSellFor(session)
          .map((o) => o.slug)
          .sort(),
      ).toEqual(
        allOfferings()
          .map((o) => o.slug)
          .sort(),
      );
    });

    it("excludes the kind already in the cart (one race in cart → no race tile)", () => {
      const race = newItem("race");
      const session = sessionWithItems({ items: [race], center: "fort-myers" });
      expect(crossSellFor(session).map((o) => o.kind)).not.toContain("race");
    });

    it("excludes a specific attraction slug but keeps other attractions", () => {
      const gel = { ...(newItem("attraction") as AttractionItem), slug: "gel-blaster" };
      const session = sessionWithItems({ items: [gel], center: "fort-myers" });
      const slugs = crossSellFor(session).map((o) => o.slug);
      expect(slugs).not.toContain("gel-blaster");
      expect(slugs).toContain("laser-tag");
      expect(slugs).toContain("duck-pin");
      expect(slugs).toContain("shuffly");
    });

    it("respects center filtering (Naples cart → no FT-only offerings)", () => {
      const bowling = newItem("bowling");
      const session = sessionWithItems({ items: [bowling], center: "naples" });
      const slugs = crossSellFor(session).map((o) => o.slug);
      expect(slugs).not.toContain("race");
      expect(slugs).not.toContain("duck-pin");
      expect(slugs).not.toContain("shuffly");
      expect(slugs).toContain("gel-blaster");
      expect(slugs).toContain("laser-tag");
      expect(slugs).toContain("kbf");
    });

    it("mixed cart: bowling + attractions coexist in cross-sell", () => {
      const bowling = newItem("bowling");
      const session = sessionWithItems({ items: [bowling], center: "fort-myers" });
      const kinds = crossSellFor(session).map((o) => o.kind);
      expect(kinds).toContain("race");
      expect(kinds).toContain("attraction");
      expect(kinds).toContain("kbf");
    });
  });

  describe("squareBookingActivity", () => {
    it("resolves shuffly to FT-side on FastTrax entry", () => {
      const o = findOffering("shuffly")!;
      expect(squareBookingActivity(o, "fasttrax")).toBe("shuffly-fasttrax");
    });

    it("resolves shuffly to HP-side on HeadPinz entry", () => {
      const o = findOffering("shuffly")!;
      expect(squareBookingActivity(o, "headpinz")).toBe("shuffly-headpinz");
    });

    it("returns the offering slug unchanged for non-shuffly offerings", () => {
      expect(squareBookingActivity(findOffering("race")!, "fasttrax")).toBe("race");
      expect(squareBookingActivity(findOffering("bowling")!, "headpinz")).toBe("bowling");
      expect(squareBookingActivity(findOffering("gel-blaster")!, "fasttrax")).toBe("gel-blaster");
    });
  });

  describe("isOfferingInPromoScope", () => {
    const racingOnly: AppliedPromo = {
      code: "RACE25",
      domains: ["racing"],
      scopes: { racing: { productSlugs: null } },
      startsAt: "2026-05-01T00:00:00Z",
      expiresAt: "2026-06-01T00:00:00Z",
      allowedWeekdays: null,
      bookingDateStart: null,
      bookingDateEnd: null,
      mechanic: "percent",
      amountPct: 25,
      amountCents: null,
      squareCatalogId: null,
    };
    const racingSpecific: AppliedPromo = {
      ...racingOnly,
      code: "RACE25-PACK",
      scopes: { racing: { productSlugs: ["race-pack"] } },
    };
    const bowlingAll: AppliedPromo = {
      ...racingOnly,
      code: "BOWL10",
      domains: ["bowling"],
      scopes: { bowling: { experienceSlugs: null } },
    };
    const bowlingKbfOnly: AppliedPromo = {
      ...bowlingAll,
      code: "KBF-FREE",
      // Admin bowling_experiences slugs use "kbf-*" for KBF rows.
      scopes: { bowling: { experienceSlugs: ["kbf-regular", "kbf-vip"] } },
    };
    const bowlingHourlyOnly: AppliedPromo = {
      ...bowlingAll,
      code: "BOWL-MON",
      // Admin slugs for regular bowling experiences (no "kbf" prefix).
      scopes: { bowling: { experienceSlugs: ["regular-mon-thur", "vip-mon-thur"] } },
    };
    const gelBlasterOnly: AppliedPromo = {
      ...racingOnly,
      code: "GEL5",
      domains: ["attractions"],
      scopes: { attractions: { slugs: ["gel-blaster"] } },
    };

    it("racing-scoped promo highlights race tile (admin slug vocab differs; domain match wins)", () => {
      expect(isOfferingInPromoScope(findOffering("race")!, racingOnly)).toBe(true);
      // Even with a specific productSlugs allowlist that doesn't include
      // "race", the race tile still highlights — admin slugs like
      // "race-pack" / "adult-arrive-drive" are not v2 catalog slugs.
      expect(isOfferingInPromoScope(findOffering("race")!, racingSpecific)).toBe(true);
      expect(isOfferingInPromoScope(findOffering("bowling")!, racingOnly)).toBe(false);
      expect(isOfferingInPromoScope(findOffering("gel-blaster")!, racingOnly)).toBe(false);
    });

    it("bowling scope with null allowlist highlights bowling but NOT kbf (KBF is opt-in)", () => {
      expect(isOfferingInPromoScope(findOffering("bowling")!, bowlingAll)).toBe(true);
      // KBF never badges off a generic/all-bowling code — only explicit kbf-* slugs.
      expect(isOfferingInPromoScope(findOffering("kbf")!, bowlingAll)).toBe(false);
      expect(isOfferingInPromoScope(findOffering("race")!, bowlingAll)).toBe(false);
    });

    it("bowling scope with only kbf-prefixed experience slugs highlights ONLY kbf", () => {
      expect(isOfferingInPromoScope(findOffering("kbf")!, bowlingKbfOnly)).toBe(true);
      expect(isOfferingInPromoScope(findOffering("bowling")!, bowlingKbfOnly)).toBe(false);
    });

    it("bowling scope with only non-kbf experience slugs highlights ONLY bowling", () => {
      expect(isOfferingInPromoScope(findOffering("bowling")!, bowlingHourlyOnly)).toBe(true);
      expect(isOfferingInPromoScope(findOffering("kbf")!, bowlingHourlyOnly)).toBe(false);
    });

    it("attractions promo with a specific slug only matches that slug", () => {
      expect(isOfferingInPromoScope(findOffering("gel-blaster")!, gelBlasterOnly)).toBe(true);
      expect(isOfferingInPromoScope(findOffering("laser-tag")!, gelBlasterOnly)).toBe(false);
      expect(isOfferingInPromoScope(findOffering("duck-pin")!, gelBlasterOnly)).toBe(false);
    });
  });

  describe("initialOfferingsFor", () => {
    const bowlingOnly: AppliedPromo = {
      code: "BOWL10",
      domains: ["bowling"],
      scopes: { bowling: { experienceSlugs: null } },
      startsAt: "2026-05-01T00:00:00Z",
      expiresAt: "2026-06-01T00:00:00Z",
      allowedWeekdays: null,
      bookingDateStart: null,
      bookingDateEnd: null,
      mechanic: "percent",
      amountPct: 10,
      amountCents: null,
      squareCatalogId: null,
    };

    it("null promo returns the full catalog", () => {
      expect(initialOfferingsFor(null)).toEqual([...allOfferings()]);
    });

    it("promo-applied returns the full catalog too (filtering is now highlighting-only, handled in the UI)", () => {
      // Landing pattern as of rev 2.5: show everything; UI marks the
      // ones in `isOfferingInPromoScope`. The customer can still click
      // a non-eligible tile.
      expect(initialOfferingsFor(bowlingOnly)).toEqual([...allOfferings()]);
    });
  });

  describe("effectiveBrand", () => {
    it("returns the offering's brand when fixed", () => {
      expect(effectiveBrand(findOffering("race")!, "headpinz")).toBe("fasttrax");
      expect(effectiveBrand(findOffering("bowling")!, "fasttrax")).toBe("headpinz");
    });

    it("returns the entry brand when the offering's brand is auto (shuffly)", () => {
      expect(effectiveBrand(findOffering("shuffly")!, "fasttrax")).toBe("fasttrax");
      expect(effectiveBrand(findOffering("shuffly")!, "headpinz")).toBe("headpinz");
    });
  });

  describe("landingOfferingsFor", () => {
    it("Naples (HPN) scopes to ONLY Naples-available offerings — drops FT-only", () => {
      const slugs = landingOfferingsFor("headpinz", "naples").map((o) => o.slug);
      expect(slugs).not.toContain("race");
      expect(slugs).not.toContain("duck-pin");
      expect(slugs).not.toContain("shuffly");
      expect([...slugs].sort()).toEqual(["bowling", "gel-blaster", "kbf", "laser-tag"]);
    });

    it("HeadPinz Fort Myers (HPFM) shows everything with HP activities FIRST", () => {
      const list = landingOfferingsFor("headpinz", "fort-myers");
      expect(list.map((o) => o.slug)).toEqual(
        expect.arrayContaining(["race", "duck-pin", "bowling", "kbf"]),
      );
      // Every HP-brand offering (shuffly resolves to HP here) precedes every FT one.
      const brands = list.map((o) => effectiveBrand(o, "headpinz"));
      expect(brands.lastIndexOf("headpinz")).toBeLessThan(brands.indexOf("fasttrax"));
    });

    it("FastTrax shows everything with FastTrax activities FIRST", () => {
      const list = landingOfferingsFor("fasttrax", "fort-myers");
      const brands = list.map((o) => effectiveBrand(o, "fasttrax"));
      expect(brands.lastIndexOf("fasttrax")).toBeLessThan(brands.indexOf("headpinz"));
      // shuffly resolves to FT on FastTrax → groups with the FT-first set.
      const ftSlugs = list
        .filter((o) => effectiveBrand(o, "fasttrax") === "fasttrax")
        .map((o) => o.slug);
      expect(ftSlugs).toEqual(expect.arrayContaining(["race", "duck-pin", "shuffly"]));
    });

    it("unknown center shows the full catalog, brand-sorted", () => {
      const list = landingOfferingsFor("headpinz", null);
      expect(list.length).toBe(allOfferings().length);
      const brands = list.map((o) => effectiveBrand(o, "headpinz"));
      expect(brands.lastIndexOf("headpinz")).toBeLessThan(brands.indexOf("fasttrax"));
    });

    it("never mutates the CATALOG order", () => {
      const before = allOfferings().map((o) => o.slug);
      landingOfferingsFor("headpinz", "fort-myers");
      landingOfferingsFor("fasttrax", null);
      expect(allOfferings().map((o) => o.slug)).toEqual(before);
    });
  });
});

describe("kiosk Spanish copy (repo rule: guest-facing copy ships EN + ES together)", () => {
  it("every offering carries a Spanish blurb — the kiosk attraction shelf renders it", () => {
    for (const o of allOfferings()) {
      expect(o.es?.blurb?.trim(), `missing es.blurb for ${o.slug}`).toBeTruthy();
      expect(o.es?.blurb, `es.blurb for ${o.slug} is still the English string`).not.toBe(o.blurb);
    }
  });

  it("leaves brand/product proper nouns in English (no es.displayName)", () => {
    // Locked glossary — these tile titles are product names, not descriptions.
    for (const slug of ["shuffly", "gel-blaster", "laser-tag", "kbf"]) {
      expect(
        findOffering(slug)?.es?.displayName,
        `${slug} should keep its English name`,
      ).toBeUndefined();
    }
    // Descriptive titles DO translate.
    expect(findOffering("race")?.es?.displayName).toBe("Carreras eléctricas de alta velocidad");
  });
});

describe("seasonal offerings (Kids Bowl Free)", () => {
  it("in season, kbf surfaces on the landing, at each center, and in cross-sell", () => {
    expect(allOfferings().map((o) => o.slug)).toContain("kbf");
    expect(offeringsAt("fort-myers").map((o) => o.slug)).toContain("kbf");
    expect(offeringsAt("naples").map((o) => o.slug)).toContain("kbf");
    expect(landingOfferingsFor("headpinz", null).map((o) => o.slug)).toContain("kbf");
    expect(crossSellFor(sessionWithItems({})).map((o) => o.slug)).toContain("kbf");
  });

  describe("out of season", () => {
    beforeEach(() => {
      vi.setSystemTime(OFF_SEASON);
    });

    it("drops kbf from every surface a guest can book from", () => {
      expect(allOfferings().map((o) => o.slug)).not.toContain("kbf");
      expect(offeringsAt("fort-myers").map((o) => o.slug)).not.toContain("kbf");
      expect(offeringsAt("naples").map((o) => o.slug)).not.toContain("kbf");
      expect(landingOfferingsFor("headpinz", null).map((o) => o.slug)).not.toContain("kbf");
      expect(landingOfferingsFor("headpinz", "naples").map((o) => o.slug)).not.toContain("kbf");
      expect(landingOfferingsFor("fasttrax", null).map((o) => o.slug)).not.toContain("kbf");
      expect(crossSellFor(sessionWithItems({})).map((o) => o.slug)).not.toContain("kbf");
      expect(initialOfferingsFor(null).map((o) => o.slug)).not.toContain("kbf");
    });

    it("still RESOLVES the kbf slug — the route, cart labels and taken reservations need it", () => {
      // The most important line in this file. Filtering findOffering would
      // strip the display name off every KBF item already in a cart and off
      // every reservation taken during the season.
      const kbf = findOffering("kbf");
      expect(kbf?.kind).toBe("kbf");
      expect(kbf?.displayName).toBe("Kids Bowl Free");
    });

    it("takes nothing else off sale", () => {
      const slugs = allOfferings().map((o) => o.slug);
      const yearRound = ["race", "duck-pin", "shuffly", "bowling", "gel-blaster", "laser-tag"];
      for (const slug of yearRound) {
        expect(slugs, `${slug} is not seasonal and must stay bookable`).toContain(slug);
      }
    });
  });
});
