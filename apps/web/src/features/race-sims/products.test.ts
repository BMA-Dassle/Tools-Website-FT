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

  it("refuses a pack while its credit deposit kind is unminted", () => {
    // A pack sells CREDITS. Charging with nowhere to bank them takes the
    // guest's money and gives nothing, so the guard must refuse on the missing
    // deposit kind in its own right — not merely because `bookable` is false.
    expect(RACE_SIM_DEPOSIT_KIND.anytime).toBeNull();
    for (const p of RACE_SIM_PRODUCTS.filter((x) => x.kind === "pack")) {
      expect(p.depositKindId ?? null, `${p.slug} deposit kind`).toBeNull();
      expect(raceSimItemConfigured({ productSlug: p.slug, trackKey: "a" })).toBe(false);
    }
  });

  it("ARMED 2026-08-26: every money id is set and singles are configured per track", () => {
    // Pins the live wiring so a stray edit can't silently unarm (or re-arm
    // with a wrong id) what the owner provided: shared Square id, one $0 key
    // per track, one shared public-booking page.
    expect(RACE_SIM_SQUARE_CATALOG_ID).toBe("PZXWYNOY4MUAPXACMBMTFYMD");
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

  it("a deferred pack is never configured, even with every id armed", () => {
    // bookable:false is its own gate — guard 2e refuses a stale pack draft
    // regardless of key state.
    expect(raceSimItemConfigured({ productSlug: "sim-3-pack", trackKey: "a" })).toBe(false);
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
