import { describe, expect, it } from "vitest";
import {
  RACE_SIM_DEPOSIT_KIND,
  RACE_SIM_PRODUCTS,
  RACE_SIM_TRACKS,
  RACE_SIM_PAGE_ID,
  RACE_SIM_SQUARE_CATALOG_ID,
  RaceSimMixedCartError,
  RaceSimNotConfiguredError,
  getRaceSimProduct,
  getRaceSimTrack,
  raceSimBookingTarget,
  raceSimItemConfigured,
  raceSimPackPerRace,
  raceSimPackSaving,
  raceSimPriceFor,
  raceSimSinglePrice,
  raceSimProductBookable,
} from "./products";
import {
  RACE_CREDIT_TYPES,
  creditTypeById,
  creditTypeForDepositName,
} from "~/features/booking/data/race-credits";

describe("race-sims catalog", () => {
  it("carries exactly one single-race SKU plus the pack SKUs", () => {
    const singles = RACE_SIM_PRODUCTS.filter((p) => p.kind === "single");
    expect(singles).toHaveLength(1);
    expect(singles[0]!.raceCount).toBe(1);
    expect(raceSimProductBookable(singles[0]!)).toBe(true);
    expect(RACE_SIM_PRODUCTS.filter((p) => p.kind === "pack")).toHaveLength(3);
  });

  it("DERIVES pack sellability from the deposit kind, never a hand-set flag", () => {
    // A pack sells CREDITS. `bookable` and `depositKindId` would be two
    // switches for one fact, and the failure mode of them disagreeing is a
    // pack that takes money and banks nothing. So packs carry no flag at all
    // and raceSimProductBookable reads the deposit kind — which means the
    // owner minting the Pandora kind IS the launch step, and nobody can arm
    // the charge early by flipping a boolean.
    for (const p of RACE_SIM_PRODUCTS.filter((x) => x.kind === "pack")) {
      expect(p.bookable, `${p.slug} must not hand-set bookable`).toBeUndefined();
      expect(raceSimProductBookable(p)).toBe(!!p.depositKindId);
    }
  });

  it("resolves products and tracks by key and misses safely", () => {
    expect(getRaceSimProduct("sim-single")?.name).toBe("1 Race");
    expect(getRaceSimProduct("nope")).toBeNull();
    expect(getRaceSimProduct(null)).toBeNull();
    expect(RACE_SIM_TRACKS.map((t) => t.key)).toEqual(["a", "b", "c"]);
    expect(getRaceSimTrack("b")?.conflictLabel).toBe("Track B");
    expect(getRaceSimTrack(null)).toBeNull();
  });

  it("prices the single at the ADVERTISED flat $14.95 (owner 2026-09-15)", () => {
    // $14.95 is the number Jacob published in Teams on 2026-08-25. The catalog
    // had carried $15.95 because the pack ladder was reverse-engineered from
    // it; the owner's call was to keep the advertised single and re-cut the
    // packs so the published percentages are true.
    //
    // Race-pack parity: a race single is one price per tier and the day
    // dimension lives in the pack VARIANTS, never as a split on one SKU. The
    // old $14/$16 split is what made the pack "% off" false on weekdays.
    const single = getRaceSimProduct("sim-single")!;
    expect(single.price).toBe(14.95);
    expect(raceSimPriceFor(single)).toBe(14.95);
    expect(raceSimSinglePrice()).toBe(14.95);
  });

  it("carries the 2026-09-15 re-cut pack ladder struck off $14.95", () => {
    const expected = [
      { slug: "sim-3-pack", raceCount: 3, price: 39.45, perRace: 13.15 },
      { slug: "sim-5-pack", raceCount: 5, price: 60.95, perRace: 12.19 },
      { slug: "sim-10-pack", raceCount: 10, price: 111.95, perRace: 11.195 },
    ];
    for (const e of expected) {
      const p = getRaceSimProduct(e.slug)!;
      expect(p, e.slug).toBeTruthy();
      expect(p.kind).toBe("pack");
      expect(p.raceCount).toBe(e.raceCount);
      expect(p.price).toBe(e.price);
      expect(raceSimPackPerRace(p)).toBeCloseTo(e.perRace, 2);
    }
  });

  it("every pack beats the single, and beats the pack below it, per race", () => {
    // The ladder has to actually descend: a 10-pack that costs more per race
    // than a 5-pack is a pricing typo no % badge would catch, because each
    // badge is only checked against the SINGLE.
    const packs = RACE_SIM_PRODUCTS.filter((p) => p.kind === "pack").sort(
      (a, b) => a.raceCount - b.raceCount,
    );
    let previous = raceSimSinglePrice();
    for (const p of packs) {
      const perRace = raceSimPackPerRace(p);
      expect(perRace, `${p.slug} must beat the rung below it`).toBeLessThan(previous);
      previous = perRace;
    }
  });

  it("keeps every published % off within a point of the real saving", () => {
    // The badge is the OWNER's number, hand-rounded (18.51 → 18, 24.77 → 25).
    // This holds it honest against the catalog: move the single price and
    // whichever claim stops being true fails here instead of on the tile.
    for (const p of RACE_SIM_PRODUCTS.filter((x) => x.kind === "pack")) {
      expect(p.pctOff, `${p.slug} must publish a % off`).toBeGreaterThan(0);
      const real = raceSimPackSaving(p) * 100;
      expect(
        Math.abs(real - p.pctOff!),
        `${p.slug}: claims ${p.pctOff}%, really ${real.toFixed(2)}%`,
      ).toBeLessThanOrEqual(1);
    }
  });

  it("ARMED 2026-09-15: sim credits have their OWN Pandora deposit kind", () => {
    // "Credit - Race Simulator" (61079628), read off the live Pandora
    // catalogue. It must never be one of the RACE kinds: a race credit spends
    // at $0 on a kart heat, and the two are not interchangeable.
    expect(RACE_SIM_DEPOSIT_KIND.anytime).toBe("61079628");
    expect(RACE_SIM_DEPOSIT_KIND.anytime).not.toBe("12744867"); // Race Mon-Thu
    expect(RACE_SIM_DEPOSIT_KIND.anytime).not.toBe("12744871"); // Race any day
    for (const p of RACE_SIM_PRODUCTS.filter((x) => x.kind === "pack")) {
      expect(p.depositKindId, `${p.slug} deposit kind`).toBe("61079628");
      expect(raceSimProductBookable(p), `${p.slug} sellable`).toBe(true);
    }
  });

  it("a PACK needs no track key — it buys credits, not a seat", () => {
    // The bug this prevents: requiring a booking target on a pack sends a
    // credit purchase down the reservation path, so the guest is asked to pick
    // a time for races they have not scheduled yet.
    for (const p of RACE_SIM_PRODUCTS.filter((x) => x.kind === "pack")) {
      expect(raceSimItemConfigured({ productSlug: p.slug, trackKey: null }), p.slug).toBe(true);
    }
    // A SINGLE still does — it holds a real BMI seat.
    expect(raceSimItemConfigured({ productSlug: "sim-single", trackKey: null })).toBe(false);
    expect(raceSimItemConfigured({ productSlug: "sim-single", trackKey: "a" })).toBe(true);
  });

  it("ARMED 2026-08-26: every money id is set and singles are configured per track", () => {
    // Pins the live wiring so a stray edit can't silently unarm (or re-arm
    // with a wrong id) what the owner provided: shared Square id, one $0 key
    // per track, one shared public-booking page.
    expect(RACE_SIM_SQUARE_CATALOG_ID).toBe("7IDM4CB3CUPH7RTTTD73LLXW");
    expect(RACE_SIM_PAGE_ID).toBe("59716066");
    expect(RACE_SIM_TRACKS.map((t) => t.bmiProductId)).toEqual([
      "59535405",
      "59537905",
      "59537953",
    ]);
    for (const track of RACE_SIM_TRACKS) {
      expect(raceSimBookingTarget(track.key)).toEqual({
        productId: track.bmiProductId,
        pageId: "59716066",
      });
      expect(raceSimItemConfigured({ productSlug: "sim-single", trackKey: track.key })).toBe(true);
    }
  });

  it("FAIL-CLOSED edges stay closed: no track picked, unknown track, unknown product", () => {
    expect(raceSimItemConfigured({ productSlug: "sim-single", trackKey: null })).toBe(false);
    expect(raceSimItemConfigured({ productSlug: "sim-single", trackKey: "x" })).toBe(false);
    expect(raceSimItemConfigured({ productSlug: "nope", trackKey: "a" })).toBe(false);
  });

  it("sim credits and KART credits can never cross-redeem", () => {
    // The single most important invariant of the pack rail. Karting's
    // redemption resolves a racer's deposits by NAME SUBSTRING
    // (race-credits.ts creditTypeForDepositName), so a sim kind whose name
    // happened to contain "anytime" / "comp" / "weekday" would silently become
    // spendable on a kart heat — a guest buying sim credits would get free
    // karting, and the sim ledger would drain without anyone racing a sim.
    const simKind = RACE_SIM_DEPOSIT_KIND.anytime!;
    for (const t of RACE_CREDIT_TYPES) {
      expect(t.depositKindId, `karting kind ${t.label} collides with the sim kind`).not.toBe(
        simKind,
      );
    }
    expect(creditTypeForDepositName("Credit - Race Simulator")).toBeNull();
    expect(creditTypeById(simKind)).toBeNull();
    // And the reverse, so this exercises the matcher rather than passing on a
    // broken import.
    expect(creditTypeForDepositName("Credit - Race Anytime")?.depositKindId).toBe("12744871");
  });

  it("a pack with NO deposit kind is refused, however else it is armed", () => {
    // The fail-closed property that matters most: sellability is DERIVED from
    // the deposit kind, so un-minting it (or a bad id) takes packs off sale
    // instantly rather than charging for credits with nowhere to bank them.
    // Asserted through the real accessors on a synthetic product, so it keeps
    // holding if the catalog changes shape.
    const armed = getRaceSimProduct("sim-3-pack")!;
    expect(raceSimProductBookable(armed)).toBe(true);
    expect(raceSimProductBookable({ ...armed, depositKindId: null })).toBe(false);
    expect(raceSimProductBookable({ ...armed, depositKindId: undefined })).toBe(false);
  });

  it("booking target misses safely for no/unknown track", () => {
    expect(raceSimBookingTarget(null)).toBeNull();
    expect(raceSimBookingTarget("x")).toBeNull();
  });

  it("errors carry greppable codes + staff-readable messages", () => {
    const notConfigured = new RaceSimNotConfiguredError("sim-single");
    expect(notConfigured.code).toBe("RACESIM_NOT_CONFIGURED");
    expect(notConfigured.message).toContain("front desk");
    const mixed = new RaceSimMixedCartError();
    expect(mixed.code).toBe("RACESIM_MIXED_CART");
    expect(mixed.message).toContain("separately");
  });
});
