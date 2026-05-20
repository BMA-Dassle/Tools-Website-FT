import { describe, expect, it } from "vitest";
import {
  allOfferings,
  crossSellFor,
  effectiveBrand,
  findOffering,
  initialOfferingsFor,
  isOfferingInPromoScope,
  offeringsAt,
  squareBookingActivity,
} from "./activities-catalog";
import { emptySession, newItem } from "./state/types";
import type { BookingSession, AttractionItem } from "./state/types";
import type { AppliedPromo } from "~/features/discount-codes";

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
      mechanic: "percent",
      amountPct: 25,
      amountCents: null,
      squareCatalogId: null,
    };
    const bowlingOnly: AppliedPromo = {
      ...racingOnly,
      code: "BOWL10",
      domains: ["bowling"],
      scopes: { bowling: { experienceSlugs: null } },
    };
    const gelBlasterOnly: AppliedPromo = {
      ...racingOnly,
      code: "GEL5",
      domains: ["attractions"],
      scopes: { attractions: { slugs: ["gel-blaster"] } },
    };

    it("racing-scoped promo matches race only", () => {
      expect(isOfferingInPromoScope(findOffering("race")!, racingOnly)).toBe(true);
      expect(isOfferingInPromoScope(findOffering("bowling")!, racingOnly)).toBe(false);
      expect(isOfferingInPromoScope(findOffering("gel-blaster")!, racingOnly)).toBe(false);
    });

    it("bowling-scoped promo matches bowling AND kbf (kbf rides under bowling domain)", () => {
      expect(isOfferingInPromoScope(findOffering("bowling")!, bowlingOnly)).toBe(true);
      expect(isOfferingInPromoScope(findOffering("kbf")!, bowlingOnly)).toBe(true);
      expect(isOfferingInPromoScope(findOffering("race")!, bowlingOnly)).toBe(false);
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
      mechanic: "percent",
      amountPct: 10,
      amountCents: null,
      squareCatalogId: null,
    };

    it("null promo passes through to allOfferings", () => {
      expect(initialOfferingsFor(null)).toEqual([...allOfferings()]);
    });

    it("bowling-only promo filters to bowling + kbf only", () => {
      const slugs = initialOfferingsFor(bowlingOnly).map((o) => o.slug);
      expect(slugs).toEqual(["bowling", "kbf"]);
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
});
