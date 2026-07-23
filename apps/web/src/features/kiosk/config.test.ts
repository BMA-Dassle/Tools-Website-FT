import { describe, expect, it } from "vitest";
import {
  gameZoneCapability,
  mergeKioskConfig,
  parseKioskConfigFromSearchParams,
  resolveKioskConfig,
  type KioskConfig,
} from "./config";

describe("gameZoneCapability", () => {
  const base = (over: Partial<KioskConfig>): KioskConfig =>
    resolveKioskConfig({ center: "fort-myers", ...over })!;

  it("is 'none' when both the CRT and MSR are off, even with a stale dispenserId", () => {
    // The CRT serial lingers in dispenserId after the toggle is turned off — it
    // must NOT keep Game Zone alive (owner 2026-07-21).
    expect(gameZoneCapability(base({ dispenserId: "SN9", cardReaderEnabled: false }))).toBe("none");
  });

  it("is 'full' only when the CRT is enabled AND a dispenser is present", () => {
    expect(gameZoneCapability(base({ cardReaderEnabled: true, dispenserId: "SN9" }))).toBe("full");
    expect(gameZoneCapability(base({ cardReaderEnabled: true, dispenserId: null }))).toBe("none");
  });

  it("is 'reload' for an MSR-only kiosk", () => {
    expect(gameZoneCapability(base({ msrEnabled: true }))).toBe("reload");
  });

  it("is 'none' for a null config", () => {
    expect(gameZoneCapability(null)).toBe("none");
  });
});

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

  it("defaults the card-reader fields off/null", () => {
    expect(resolveKioskConfig({ center: "fort-myers" })).toMatchObject({
      cardReaderEnabled: false,
      cardReaderBaud: null,
      cardReaderPortInfo: null,
    });
  });

  it("defaults the qr-scanner fields off/null", () => {
    expect(resolveKioskConfig({ center: "fort-myers" })).toMatchObject({
      qrScannerEnabled: false,
      qrScannerModel: null,
      qrScannerBaud: null,
      qrScannerPortInfo: null,
    });
  });

  it("qr-scanner fields survive resolve + merge (readStorage re-resolves on boot)", () => {
    // The strip-guard: a field missing from resolveKioskConfig's literal is
    // silently dropped on every boot — this test catches that.
    const saved = resolveKioskConfig({
      center: "fort-myers",
      qrScannerEnabled: true,
      qrScannerModel: "honeywell-3320g",
      qrScannerBaud: 115200,
      qrScannerPortInfo: { usbVendorId: 0x0c2e, usbProductId: 0x0b61 },
    });
    const expected = {
      qrScannerEnabled: true,
      qrScannerModel: "honeywell-3320g",
      qrScannerBaud: 115200,
      qrScannerPortInfo: { usbVendorId: 0x0c2e, usbProductId: 0x0b61 },
    };
    expect(saved).toMatchObject(expected);
    expect(resolveKioskConfig(saved!)).toMatchObject(expected);
    expect(mergeKioskConfig(saved, { variant: "pitcrew" })).toMatchObject(expected);
  });

  it("card-reader fields survive resolve + merge (readStorage re-resolves on boot)", () => {
    const saved = resolveKioskConfig({
      center: "fort-myers",
      cardReaderEnabled: true,
      cardReaderBaud: 38400,
      cardReaderPortInfo: { usbVendorId: 0x0403, usbProductId: 0x6001 },
      dispenserId: "SN42",
    });
    expect(saved).toMatchObject({
      cardReaderEnabled: true,
      cardReaderBaud: 38400,
      cardReaderPortInfo: { usbVendorId: 0x0403, usbProductId: 0x6001 },
      dispenserId: "SN42",
    });
    // Round-trip through resolve again (what readStorage does) — no stripping.
    expect(resolveKioskConfig(saved!)).toMatchObject({
      cardReaderEnabled: true,
      cardReaderBaud: 38400,
      cardReaderPortInfo: { usbVendorId: 0x0403, usbProductId: 0x6001 },
    });
    // And through a URL merge that touches unrelated fields.
    expect(mergeKioskConfig(saved, { variant: "pitcrew" })).toMatchObject({
      cardReaderEnabled: true,
      cardReaderBaud: 38400,
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
