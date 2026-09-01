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
} from "./products";

describe("race-sims catalog", () => {
  it("carries exactly one single-race SKU plus the (deferred) pack SKUs", () => {
    const singles = RACE_SIM_PRODUCTS.filter((p) => p.kind === "single");
    expect(singles).toHaveLength(1);
    expect(singles[0]!.raceCount).toBe(1);
    expect(singles[0]!.bookable).toBe(true);
    // Owner 2026-08-23: pack keys not minted — packs stay visible but unsellable.
    for (const p of RACE_SIM_PRODUCTS.filter((x) => x.kind === "pack")) {
      expect(p.bookable).toBe(false);
    }
  });

  it("resolves products and tracks by key and misses safely", () => {
    expect(getRaceSimProduct("sim-single")?.name).toBe("1 Race");
    expect(getRaceSimProduct("nope")).toBeNull();
    expect(getRaceSimProduct(null)).toBeNull();
    expect(RACE_SIM_TRACKS.map((t) => t.key)).toEqual(["a", "b", "c"]);
    expect(getRaceSimTrack("b")?.name).toBe("Track B");
    expect(getRaceSimTrack(null)).toBeNull();
  });

  it("prices the single at a FLAT $15.95 — no day-split (owner 2026-09-01)", () => {
    // Race-pack parity: a race single is one price per tier and the day
    // dimension lives in the pack VARIANTS, never as a split on one SKU. The
    // old $14/$16 split is what made the pack "% off" false on weekdays.
    const single = getRaceSimProduct("sim-single")!;
    expect(single.price).toBe(15.95);
    expect(raceSimPriceFor(single)).toBe(15.95);
    expect(raceSimSinglePrice()).toBe(15.95);
  });

  it("carries the owner's 3/5/10 pack prices at $14/$13/$12 a race", () => {
    const expected = [
      { slug: "sim-3-pack", raceCount: 3, price: 41.99, perRace: 14 },
      { slug: "sim-5-pack", raceCount: 5, price: 64.99, perRace: 13 },
      { slug: "sim-10-pack", raceCount: 10, price: 119.99, perRace: 12 },
    ];
    for (const e of expected) {
      const p = getRaceSimProduct(e.slug)!;
      expect(p, e.slug).toBeTruthy();
      expect(p.kind).toBe("pack");
      expect(p.raceCount).toBe(e.raceCount);
      expect(p.price).toBe(e.price);
      // Per-race rounds to the advertised whole dollar (41.99/3 = 13.9967).
      expect(raceSimPackPerRace(p)).toBeCloseTo(e.perRace, 1);
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
