import { describe, expect, it } from "vitest";
import { normalizeBookedAt, normalizeGuestPhone } from "../qamf-bowling";

describe("normalizeBookedAt", () => {
  it("zeroes the seconds and milliseconds QAMF rejects", () => {
    // The exact value the 2026-07-28 orphan sent: QAMF 400'd with
    // "BookedAt: Millisecond must be 0."
    expect(normalizeBookedAt("2026-07-28T17:15:38.230Z")).toBe("2026-07-28T17:15:00Z");
  });

  it("preserves the offset untouched — QAMF reads it as center-local wall clock", () => {
    expect(normalizeBookedAt("2026-07-28T18:00:00.500-04:00")).toBe("2026-07-28T18:00:00-04:00");
    expect(normalizeBookedAt("2026-07-28T18:00:00-04:00")).toBe("2026-07-28T18:00:00-04:00");
  });

  it("leaves an already-clean slot ISO byte-identical", () => {
    const clean = "2026-08-01T14:00:00-04:00";
    expect(normalizeBookedAt(clean)).toBe(clean);
  });

  it("handles a minute-precision value with no seconds at all", () => {
    expect(normalizeBookedAt("2026-07-28T17:15-04:00")).toBe("2026-07-28T17:15:00-04:00");
  });

  it("passes an unparseable value straight through for the vendor to judge", () => {
    expect(normalizeBookedAt("not-a-date")).toBe("not-a-date");
    expect(normalizeBookedAt("")).toBe("");
  });
});

describe("normalizeGuestPhone", () => {
  it("strips the kiosk display format QAMF rejected", () => {
    expect(normalizeGuestPhone("(973) 518-4297")).toBe("9735184297");
  });

  it("strips dashes, dots and spaces", () => {
    expect(normalizeGuestPhone("305-322-9853")).toBe("3053229853");
    expect(normalizeGuestPhone("239.784.4666")).toBe("2397844666");
    expect(normalizeGuestPhone(" 239 784 4666 ")).toBe("2397844666");
  });

  it("drops a leading US country code", () => {
    expect(normalizeGuestPhone("1 (941) 539-2166")).toBe("9415392166");
    expect(normalizeGuestPhone("19415392166")).toBe("9415392166");
  });

  it("leaves an already-bare 10-digit number alone", () => {
    expect(normalizeGuestPhone("9735184297")).toBe("9735184297");
  });

  it("keeps a non-US-length number's digits rather than mangling them", () => {
    expect(normalizeGuestPhone("+44 20 7946 0958")).toBe("442079460958");
  });

  it("survives null/undefined/empty", () => {
    expect(normalizeGuestPhone(null)).toBe("");
    expect(normalizeGuestPhone(undefined)).toBe("");
    expect(normalizeGuestPhone("")).toBe("");
  });
});
