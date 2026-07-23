import { describe, expect, it } from "vitest";
import { legacyKioskDeviceLookup } from "./kiosk-devices-db";

describe("legacyKioskDeviceLookup", () => {
  it("maps HPN to the legacy naples key (headpinz)", () => {
    expect(legacyKioskDeviceLookup("HPN:3")).toEqual({ key: "naples:3", brand: "headpinz" });
  });

  it("maps HPFM to the legacy fort-myers key requiring the headpinz brand", () => {
    expect(legacyKioskDeviceLookup("HPFM:14")).toEqual({
      key: "fort-myers:14",
      brand: "headpinz",
    });
  });

  it("maps FT to the legacy fort-myers key requiring the fasttrax brand", () => {
    expect(legacyKioskDeviceLookup("FT:7")).toEqual({ key: "fort-myers:7", brand: "fasttrax" });
  });

  it("returns null for keys that are already legacy-form or malformed", () => {
    expect(legacyKioskDeviceLookup("fort-myers:14")).toBeNull();
    expect(legacyKioskDeviceLookup("naples:3")).toBeNull();
    expect(legacyKioskDeviceLookup("HPFM")).toBeNull();
    expect(legacyKioskDeviceLookup("HPFM:")).toBeNull();
    expect(legacyKioskDeviceLookup("HPFM:abc")).toBeNull();
    expect(legacyKioskDeviceLookup("")).toBeNull();
  });
});
