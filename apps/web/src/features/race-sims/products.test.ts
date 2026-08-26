import { describe, expect, it } from "vitest";
import {
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
  raceSimPriceFor,
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

  it("prices $14 Mon–Thu and $16 Fri–Sun (house day-split), weekend on bad dates", () => {
    const single = getRaceSimProduct("sim-single")!;
    expect(raceSimPriceFor(single, "2026-08-24")).toBe(14); // Monday
    expect(raceSimPriceFor(single, "2026-08-27")).toBe(14); // Thursday
    expect(raceSimPriceFor(single, "2026-08-28")).toBe(16); // Friday
    expect(raceSimPriceFor(single, "2026-08-29")).toBe(16); // Saturday
    expect(raceSimPriceFor(single, "2026-08-23")).toBe(16); // Sunday
    // Never undercharge on a missing/garbage date.
    expect(raceSimPriceFor(single, null)).toBe(16);
    expect(raceSimPriceFor(single, "garbage")).toBe(16);
  });

  it("FAIL-CLOSED: no item is configured while the BMI page is null", () => {
    // Square id + all three track keys ARE armed (owner 2026-08-23/26) — a
    // key without its public-booking page can't fetch availability or book,
    // so the page is the last gate: charging must stay closed until it lands.
    expect(RACE_SIM_SQUARE_CATALOG_ID).toBe("PZXWYNOY4MUAPXACMBMTFYMD");
    expect(RACE_SIM_TRACKS.map((t) => t.bmiProductId)).toEqual([
      "59535405",
      "59537905",
      "59537953",
    ]);
    expect(RACE_SIM_PAGE_ID).toBeNull();
    for (const track of RACE_SIM_TRACKS) {
      expect(raceSimBookingTarget(track.key)).toBeNull();
    }
    expect(raceSimItemConfigured({ productSlug: "sim-single", trackKey: "a" })).toBe(false);
  });

  it("a deferred pack is never configured, even with every id armed", () => {
    // bookable:false is its own gate — guard 2e refuses a stale pack draft
    // regardless of key state.
    expect(raceSimItemConfigured({ productSlug: "sim-3-pack", trackKey: "a" })).toBe(false);
  });

  it("booking target requires BOTH the track key and the shared page", () => {
    expect(raceSimBookingTarget("a")).toBeNull();
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
