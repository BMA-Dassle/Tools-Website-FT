import { describe, expect, it } from "vitest";
import {
  ageFromDob,
  ageFromIso,
  brandLocationFor,
  buildGuestPayload,
  centerDisplayName,
  endedFromMeta,
  formatDobInput,
  formatPhoneInput,
  toIsoDob,
} from "./join-helpers";

describe("formatDobInput", () => {
  it("auto-slashes as digits are typed", () => {
    expect(formatDobInput("0")).toBe("0");
    expect(formatDobInput("041")).toBe("04/1");
    expect(formatDobInput("04101992")).toBe("04/10/1992");
    expect(formatDobInput("04/10/1992")).toBe("04/10/1992");
    expect(formatDobInput("041019923")).toBe("04/10/1992"); // capped at 8 digits
  });
});

describe("formatPhoneInput", () => {
  it("formats live and strips the autofill +1", () => {
    expect(formatPhoneInput("239")).toBe("239");
    expect(formatPhoneInput("2395551")).toBe("(239) 555-1");
    expect(formatPhoneInput("2395551234")).toBe("(239) 555-1234");
    expect(formatPhoneInput("+1 (239) 555-1234")).toBe("(239) 555-1234");
  });
});

describe("ageFromDob / ageFromIso", () => {
  it("computes ages and rejects malformed or impossible dates", () => {
    expect(ageFromDob("01/15/1990")).toBeGreaterThanOrEqual(36);
    expect(ageFromDob("1/15/1990")).toBeNull(); // not zero-padded
    expect(ageFromDob("02/30/2000")).toBeNull(); // impossible — no rollover
    expect(ageFromDob("13/01/2000")).toBeNull();
    expect(ageFromDob("01/15/1800")).toBeNull(); // ≥120
    expect(ageFromDob("01/15/2999")).toBeNull(); // future
  });

  it("reads ISO dates including datetime strings", () => {
    expect(ageFromIso("1990-01-15")).toBeGreaterThanOrEqual(36);
    expect(ageFromIso("1990-01-15T00:00:00Z")).toBeGreaterThanOrEqual(36);
    expect(ageFromIso("")).toBeNull();
    expect(ageFromIso(null)).toBeNull();
  });
});

describe("toIsoDob", () => {
  it("converts MM/DD/YYYY to ISO", () => {
    expect(toIsoDob("04/10/1992")).toBe("1992-04-10");
  });
});

describe("buildGuestPayload", () => {
  it("keeps a returning guest's 17-digit id as a string and passes extras", () => {
    const p = buildGuestPayload({
      firstName: "Ann",
      lastName: "Tester",
      bmiPersonId: "12345678901234567",
      pandoraPersonId: "88421",
      dobIso: "1990-01-15",
      phone: "(239) 555-1234",
      email: "ann@example.com",
      memberships: ["PRO 2026"],
      creditBalances: [{ kind: "race", balance: 2 }],
      isNewRacer: false,
    });
    expect(p.bmiPersonId).toBe("12345678901234567");
    expect(typeof p.bmiPersonId).toBe("string");
    expect(p.pandoraPersonId).toBe("88421");
    expect(p.isNewRacer).toBe(false);
    expect(p.category).toBe("adult");
    expect(p.waiverValid).toBe(true); // submit only happens after signing
    expect(p.memberships).toEqual(["PRO 2026"]);
  });

  it("omits absent optionals instead of sending undefined", () => {
    const p = buildGuestPayload({ firstName: "Sam", dobIso: "1992-04-10", isNewRacer: true });
    expect("lastName" in p).toBe(false);
    expect("email" in p).toBe(false);
    expect("memberships" in p).toBe(false);
    expect("creditBalances" in p).toBe(false);
  });
});

describe("endedFromMeta", () => {
  const base = { center: "fort-myers" as const, brand: "fasttrax" as const };
  it("maps close reasons to guest-facing end states", () => {
    expect(
      endedFromMeta({ status: "open", ...base, stepKind: "race", splitPaymentAvailable: false }),
    ).toBeNull();
    expect(endedFromMeta({ status: "closed", closeReason: "continued", ...base })).toBe("moved-on");
    expect(endedFromMeta({ status: "closed", closeReason: "done", ...base })).toBe("moved-on");
    expect(endedFromMeta({ status: "closed", closeReason: "start-over", ...base })).toBe(
      "cancelled",
    );
    expect(endedFromMeta({ status: "closed", closeReason: "idle", ...base })).toBe("cancelled");
    expect(endedFromMeta({ status: "closed", closeReason: "superseded", ...base })).toBe("expired");
    expect(endedFromMeta({ status: "closed", closeReason: "expired", ...base })).toBe("expired");
    expect(endedFromMeta({ status: "closed", ...base })).toBe("expired");
  });
});

describe("venue naming + waiver location", () => {
  it("names centers and mirrors the kiosk's brand-only waiver location", () => {
    expect(centerDisplayName("naples", "headpinz")).toBe("HeadPinz Naples");
    expect(centerDisplayName("fort-myers", "headpinz")).toBe("HeadPinz Fort Myers");
    expect(centerDisplayName("fort-myers", "fasttrax")).toBe("FastTrax Fort Myers");
    expect(brandLocationFor("headpinz")).toBe("headpinz");
    expect(brandLocationFor("fasttrax")).toBe("fasttrax");
  });
});
