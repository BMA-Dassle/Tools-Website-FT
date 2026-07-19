import { describe, expect, it } from "vitest";
import {
  evaluateWindow,
  optionBelongsToOffer,
  resolveOptionMinutes,
  slotExceedsClose,
  windowCheckMinutes,
  type OfferConfig,
  type ProbeMap,
} from "./duration-feasibility";

const durOpt = (qamfOptionId: number, durationMinutes: number) => ({
  id: qamfOptionId,
  experienceId: 1,
  centerCode: "TXBSQN0FEKQ11",
  qamfOptionId,
  durationMinutes,
  label: `${durationMinutes}min`,
  squareMultiplier: 1,
  sortOrder: 0,
  overrideSquareProductId: null,
  overridePriceCents: null,
  overrideDepositPct: null,
  overrideCatalogObjectId: null,
});

const hourly: OfferConfig = {
  qamfWebOfferId: 154,
  qamfOptionType: "Time",
  qamfOptionId: null,
  durationOptions: [durOpt(1227, 90), durOpt(1228, 120)],
  qamfOfferDurationMinutes: null,
};

const funForAll: OfferConfig = {
  // shares web offer 154, fixed 90-min option
  qamfWebOfferId: 154,
  qamfOptionType: "Time",
  qamfOptionId: 1227,
  durationOptions: [],
  qamfOfferDurationMinutes: 90,
};

const kbf: OfferConfig = {
  qamfWebOfferId: 152,
  qamfOptionType: "Game",
  qamfOptionId: 908,
  durationOptions: [],
  qamfOfferDurationMinutes: null,
};

describe("resolveOptionMinutes", () => {
  it("resolves duration options from our config", () => {
    expect(resolveOptionMinutes([hourly], 1227)).toBe(90);
    expect(resolveOptionMinutes([hourly], 1228)).toBe(120);
  });

  it("resolves fixed-duration offer-level minutes across sharing experiences", () => {
    expect(resolveOptionMinutes([hourly, funForAll], 1227)).toBe(90);
    expect(resolveOptionMinutes([funForAll], 1227)).toBe(90);
  });

  it("Game/Unlimited and unknown options are exempt (null), never zero", () => {
    expect(resolveOptionMinutes([kbf], 908, "Game")).toBeNull();
    expect(resolveOptionMinutes([hourly], 908)).toBeNull();
    expect(resolveOptionMinutes([hourly], null)).toBeNull();
  });
});

describe("optionBelongsToOffer", () => {
  it("accepts configured options and rejects foreign ones", () => {
    expect(optionBelongsToOffer([hourly], 1228)).toBe(true);
    expect(optionBelongsToOffer([hourly, funForAll], 1227)).toBe(true);
    // a VIP-offer option id spoofed onto the regular offer
    expect(optionBelongsToOffer([hourly, funForAll], 1235)).toBe(false);
  });

  it("accepts absent optionId, and fails open when nothing is configured", () => {
    expect(optionBelongsToOffer([hourly], null)).toBe(true);
    const unconfigured: OfferConfig = {
      qamfWebOfferId: 999,
      qamfOptionType: null,
      qamfOptionId: null,
      durationOptions: [],
      qamfOfferDurationMinutes: null,
    };
    expect(optionBelongsToOffer([unconfigured], 12345)).toBe(true);
  });
});

describe("slotExceedsClose", () => {
  // FM weekday closes at midnight (24); weekend 2 AM (26).
  it("end exactly at close is allowed; past close is rejected", () => {
    // 10:30 PM + 90min = midnight → allowed at close 24
    expect(slotExceedsClose("2026-07-20T22:30:00-04:00", 90, 24)).toBe(false);
    // 10:30 PM + 120min = 12:30 AM → rejected at close 24
    expect(slotExceedsClose("2026-07-20T22:30:00-04:00", 120, 24)).toBe(true);
    // weekend: 12:30 AM + 90min = 2:00 AM → allowed at close 26
    expect(slotExceedsClose("2026-07-25T00:30:00-04:00", 90, 26)).toBe(false);
    expect(slotExceedsClose("2026-07-25T00:30:00-04:00", 120, 26)).toBe(true);
  });

  it("handles EST offsets (winter dates) the same way", () => {
    expect(slotExceedsClose("2026-12-14T22:30:00-05:00", 90, 24)).toBe(false);
    expect(slotExceedsClose("2026-12-14T22:30:00-05:00", 120, 24)).toBe(true);
  });
});

describe("evaluateWindow (branch-D necessary condition)", () => {
  const T = 14 * 60; // 2:00 PM
  const withOffer = new Set([154, 155]);
  const withoutOffer = new Set([155]);

  it("90 fits / 120 does not when the tail is blocked (the production bug)", () => {
    const probeMap: ProbeMap = new Map([
      [T, withOffer],
      [T + 15, withOffer],
      [T + 30, withOffer],
      [T + 45, withOffer],
      [T + 60, withOffer],
      [T + 75, withOffer],
      // [T+90, T+150) blocked for offer 154:
      [T + 90, withoutOffer],
      [T + 105, withoutOffer],
      [T + 120, withoutOffer],
    ]);
    expect(evaluateWindow(probeMap, 154, T, 90)).toBe(true);
    expect(evaluateWindow(probeMap, 154, T, 120)).toBe(false);
    // the un-blocked VIP offer still fits 120
    expect(evaluateWindow(probeMap, 155, T, 120)).toBe(true);
  });

  it("unprobed instants fail open", () => {
    const sparse: ProbeMap = new Map([
      [T, withOffer],
      // T+15..T+105 never probed (coarser grid / probe errors)
    ]);
    expect(evaluateWindow(sparse, 154, T, 120)).toBe(true);
  });

  it("a single probed absence anywhere in the window rejects", () => {
    const probeMap: ProbeMap = new Map([
      [T, withOffer],
      [T + 60, withoutOffer],
    ]);
    expect(evaluateWindow(probeMap, 154, T, 90)).toBe(false);
  });
});

describe("windowCheckMinutes", () => {
  it("interior grid points only — start excluded, end excluded", () => {
    expect(windowCheckMinutes(14 * 60, 90)).toEqual([855, 870, 885, 900, 915]);
    expect(windowCheckMinutes(14 * 60, 120)).toEqual([855, 870, 885, 900, 915, 930, 945]);
  });

  it("non-15-aligned starts return no checks (defensive skip)", () => {
    expect(windowCheckMinutes(14 * 60 + 5, 90)).toEqual([]);
  });
});
