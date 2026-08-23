import { describe, expect, it } from "vitest";
import {
  RACE_SIM_PRODUCTS,
  RACE_SIM_TRACKS,
  RaceSimNotConfiguredError,
  getRaceSimProduct,
  getRaceSimTrack,
  raceSimProductConfigured,
} from "./products";

describe("race-sims placeholder catalog", () => {
  it("carries exactly one single-race SKU plus the pack SKUs", () => {
    const singles = RACE_SIM_PRODUCTS.filter((p) => p.kind === "single");
    expect(singles).toHaveLength(1);
    expect(singles[0]!.raceCount).toBe(1);
    expect(RACE_SIM_PRODUCTS.filter((p) => p.kind === "pack").length).toBeGreaterThan(0);
  });

  it("resolves products by slug and misses safely", () => {
    expect(getRaceSimProduct("sim-single")?.name).toBe("1 Race");
    expect(getRaceSimProduct("nope")).toBeNull();
    expect(getRaceSimProduct(null)).toBeNull();
  });

  it("resolves the three placeholder tracks and misses safely", () => {
    expect(RACE_SIM_TRACKS.map((t) => t.key)).toEqual(["a", "b", "c"]);
    expect(getRaceSimTrack("b")?.name).toBe("Track B");
    expect(getRaceSimTrack("x")).toBeNull();
    expect(getRaceSimTrack(null)).toBeNull();
  });

  it("FAIL-CLOSED INVARIANT: no placeholder SKU is configured to charge", () => {
    // The whole point of the placeholder phase — if this ever flips, someone
    // armed a Square id without wiring the vendor rail (see products.ts header).
    for (const p of RACE_SIM_PRODUCTS) {
      expect(raceSimProductConfigured(p)).toBe(false);
    }
  });

  it("configured() flips only when the Square money id is set", () => {
    const armed = { ...RACE_SIM_PRODUCTS[0]!, squareCatalogObjectId: "FAKE_SQ_ID" };
    expect(raceSimProductConfigured(armed)).toBe(true);
  });

  it("RaceSimNotConfiguredError carries the greppable code and the slug", () => {
    const err = new RaceSimNotConfiguredError("sim-single");
    expect(err.code).toBe("RACESIM_NOT_CONFIGURED");
    expect(err.message).toContain("front desk");
    expect(err.message).toContain("sim-single");
  });
});
