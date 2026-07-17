import { describe, expect, it } from "vitest";
import {
  mergeKioskConfig,
  parseKioskConfigFromSearchParams,
  resolveKioskConfig,
  type KioskConfig,
} from "./config";

describe("parseKioskConfigFromSearchParams", () => {
  it("parses a full provisioning URL — venue slug determines brand", () => {
    expect(
      parseKioskConfigFromSearchParams({
        center: "fasttrax",
        reader: "R123ABC",
        variant: "pitcrew",
      }),
    ).toEqual({
      center: "fort-myers",
      brand: "fasttrax",
      readerId: "R123ABC",
      variant: "pitcrew",
    });
  });

  it("maps every venue slug to its (center, brand) pair", () => {
    expect(parseKioskConfigFromSearchParams({ center: "headpinz" })).toEqual({
      center: "fort-myers",
      brand: "headpinz",
    });
    expect(parseKioskConfigFromSearchParams({ center: "naples" })).toEqual({
      center: "naples",
      brand: "headpinz",
    });
    expect(parseKioskConfigFromSearchParams({ center: "fm" })).toEqual({
      center: "fort-myers",
      brand: "fasttrax",
    });
  });

  it("accepts ?location=, explicit brand override, ignores junk", () => {
    expect(
      parseKioskConfigFromSearchParams({ location: "fm", brand: "hp", variant: "neon" }),
    ).toEqual({ center: "fort-myers", brand: "headpinz" });
    expect(parseKioskConfigFromSearchParams({})).toEqual({});
  });

  it("takes the first value of repeated params", () => {
    expect(parseKioskConfigFromSearchParams({ center: ["naples", "fasttrax"] })).toEqual({
      center: "naples",
      brand: "headpinz",
    });
  });
});

describe("resolveKioskConfig", () => {
  it("requires a center", () => {
    expect(resolveKioskConfig({})).toBeNull();
    expect(resolveKioskConfig({ brand: "fasttrax" })).toBeNull();
  });

  it("fills defaults: fasttrax brand, podium variant, no reader", () => {
    expect(resolveKioskConfig({ center: "fort-myers" })).toMatchObject({
      center: "fort-myers",
      brand: "fasttrax",
      readerId: null,
      variant: "podium",
      kioskNumber: 1,
      cardInputMethod: "manual",
    });
  });

  it("forces HeadPinz at Naples regardless of the requested brand", () => {
    expect(resolveKioskConfig({ center: "naples", brand: "fasttrax" })).toMatchObject({
      brand: "headpinz",
    });
  });
});

describe("mergeKioskConfig", () => {
  const stored: KioskConfig = {
    center: "fort-myers",
    brand: "fasttrax",
    readerId: "OLD",
    variant: "podium",
  };

  it("URL params win field-by-field over stored config", () => {
    expect(mergeKioskConfig(stored, { readerId: "NEW", variant: "pitcrew" })).toMatchObject({
      center: "fort-myers",
      brand: "fasttrax",
      readerId: "NEW",
      variant: "pitcrew",
    });
  });

  it("keeps stored config when the URL adds nothing", () => {
    expect(mergeKioskConfig(stored, {})).toMatchObject(stored);
  });

  it("still resolves from URL alone (fresh device)", () => {
    expect(mergeKioskConfig(null, { center: "naples" })).toMatchObject({
      center: "naples",
      brand: "headpinz",
      readerId: null,
      variant: "podium",
    });
  });
});
