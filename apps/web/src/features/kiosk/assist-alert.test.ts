import { describe, expect, it } from "vitest";
import { assistAlertSchema, buildAssistAlert, kioskLabel, radioServerFor } from "./assist-alert";

describe("radioServerFor", () => {
  it("routes Naples to HPN", () => {
    expect(radioServerFor({ center: "naples", brand: "headpinz" })).toBe("HPN");
  });

  it("routes HeadPinz Fort Myers to HPFM", () => {
    expect(radioServerFor({ center: "fort-myers", brand: "headpinz" })).toBe("HPFM");
  });

  it("routes FastTrax Fort Myers to FT", () => {
    expect(radioServerFor({ center: "fort-myers", brand: "fasttrax" })).toBe("FT");
  });
});

describe("kioskLabel", () => {
  it("names HPFM kiosks under 10 as Game Zone kiosks", () => {
    expect(kioskLabel({ center: "fort-myers", brand: "headpinz", kioskNumber: 3 })).toBe(
      "Game Zone kiosk 3",
    );
    expect(kioskLabel({ center: "fort-myers", brand: "headpinz", kioskNumber: 9 })).toBe(
      "Game Zone kiosk 9",
    );
  });

  it("names HPFM kiosks 10 and up as bowling kiosks", () => {
    expect(kioskLabel({ center: "fort-myers", brand: "headpinz", kioskNumber: 10 })).toBe(
      "bowling kiosk 10",
    );
    expect(kioskLabel({ center: "fort-myers", brand: "headpinz", kioskNumber: 12 })).toBe(
      "bowling kiosk 12",
    );
  });

  it("uses a plain kiosk label at FT and HPN", () => {
    expect(kioskLabel({ center: "fort-myers", brand: "fasttrax", kioskNumber: 2 })).toBe("kiosk 2");
    expect(kioskLabel({ center: "naples", brand: "headpinz", kioskNumber: 11 })).toBe("kiosk 11");
  });
});

describe("assistAlertSchema", () => {
  it("defaults reason to help (pre-reason kiosk clients)", () => {
    const parsed = assistAlertSchema.parse({
      center: "fort-myers",
      brand: "headpinz",
      kioskNumber: 3,
    });
    expect(parsed.reason).toBe("help");
  });
});

describe("buildAssistAlert", () => {
  it("builds the full radio payload", () => {
    const alert = buildAssistAlert({
      center: "fort-myers",
      brand: "headpinz",
      kioskNumber: 12,
      reason: "help",
    });
    expect(alert).toEqual({
      server: "HPFM",
      target: "FOH",
      priority: 1,
      message: "Guest needs assistance at bowling kiosk 12",
      name: "KioskAssist12",
      cooldown: 15,
    });
  });

  it("speaks a card-error message for dispenser faults, same dedup name", () => {
    const alert = buildAssistAlert({
      center: "fort-myers",
      brand: "headpinz",
      kioskNumber: 3,
      reason: "card-error",
    });
    expect(alert.message).toBe("Card error at Game Zone kiosk 3");
    expect(alert.name).toBe("KioskAssist3");
  });

  it("keeps the dedup cooldown under the kiosk's 30s repeat interval", () => {
    // The soteria janitor frees a dedup jobId up to ~10s after `cooldown`
    // expires; the repeat only plays if cooldown + 10 < 30.
    const alert = buildAssistAlert({
      center: "naples",
      brand: "headpinz",
      kioskNumber: 1,
      reason: "help",
    });
    expect(alert.cooldown + 10).toBeLessThan(30);
  });
});
