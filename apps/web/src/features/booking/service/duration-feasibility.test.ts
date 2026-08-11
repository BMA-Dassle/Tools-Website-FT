import { describe, expect, it } from "vitest";
import {
  evaluateWindow,
  minConfiguredMinutes,
  optionBelongsToOffer,
  resolveOptionMinutes,
  slotExceedsClose,
  tailForgiveMinutes,
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

  it("clamps to the offer's last bookable start", () => {
    // 10:30 PM + 90min, last start 11:00 PM (midnight close, 60-min shortest
    // option): only 10:45 and 11:00 are meaningful probe instants.
    expect(windowCheckMinutes(22 * 60 + 30, 90, 23 * 60)).toEqual([1365, 1380]);
    // no clamp → unchanged behavior
    expect(windowCheckMinutes(22 * 60 + 30, 90, null)).toEqual([1365, 1380, 1395, 1410, 1425]);
  });
});

describe("minConfiguredMinutes", () => {
  it("shortest across duration options and offer-level minutes", () => {
    expect(minConfiguredMinutes([hourly])).toBe(90);
    expect(minConfiguredMinutes([hourly, funForAll])).toBe(90);
    expect(minConfiguredMinutes([funForAll])).toBe(90);
  });

  it("null when nothing carries a duration (Game/Unlimited)", () => {
    expect(minConfiguredMinutes([kbf])).toBeNull();
    expect(minConfiguredMinutes([])).toBeNull();
  });
});

describe("evaluateWindow last-start clamp (2026-07-19 kiosk bug)", () => {
  // Sunday night at FM: close midnight (1440), Regular Fri–Sun (offer 158)
  // has 60- and 90-min options → QAMF's last listed start is 11:00 PM (1380).
  // QAMF listed 158 at 10:30/10:45/11:00 PM and NOTHING at 11:15 PM onward —
  // an artifact of the last-start rule, not lane occupancy. The 10:30 PM
  // 90-min slot is genuinely bookable and must survive.
  const close = 24 * 60;
  const lastStart = close - 60; // 1380
  const probeMap: ProbeMap = new Map([
    [1350, new Set([158, 159])], // 10:30 PM
    [1365, new Set([158, 159])], // 10:45 PM
    [1380, new Set([158, 159])], // 11:00 PM
    [1395, new Set<number>()], //   11:15 PM — nothing listed (past last start)
    [1410, new Set<number>()],
    [1425, new Set<number>()],
  ]);

  it("keeps the last-of-night slot when only past-last-start instants are absent", () => {
    expect(evaluateWindow(probeMap, 158, 1350, 90, lastStart)).toBe(true);
    // without the clamp the same window is (wrongly) rejected — the bug
    expect(evaluateWindow(probeMap, 158, 1350, 90)).toBe(false);
  });

  it("still rejects a genuine mid-window absence at or before last start", () => {
    const blocked: ProbeMap = new Map(probeMap);
    blocked.set(1365, new Set([159])); // 10:45 PM: 158 gone while starts still allowed
    expect(evaluateWindow(blocked, 158, 1350, 90, lastStart)).toBe(false);
  });
});

describe("evaluateWindow mid-day event-tail forgiveness (2026-08-10 VIP afternoon)", () => {
  // Tue 8/11 live shape: the VIP suite has corporate events from ~5:30 PM.
  // QAMF listed VIP offer 155 at 3:30–4:45 PM and NOTHING at 5:00/5:15 — a
  // start-tail artifact (no ≥60-min booking can START there before the
  // events), not occupancy: the lanes are free until the events begin.
  // QAMF's own row options said 90 min fits at 4:00; the un-forgiving window
  // check needed the offer listed at 5:00/5:15 and wrongly rejected it.
  const FOUR_PM = 16 * 60;
  const probeMap: ProbeMap = new Map([
    [FOUR_PM, new Set([154, 155])],
    [FOUR_PM + 15, new Set([154, 155])],
    [FOUR_PM + 30, new Set([155])],
    [FOUR_PM + 45, new Set([155])],
    [FOUR_PM + 60, new Set<number>()], // 5:00 PM — start-tail artifact
    [FOUR_PM + 75, new Set<number>()], // 5:15 PM
  ]);

  it("keeps 90 min at 4:00 PM — absences sit in the window's final 45 min", () => {
    expect(evaluateWindow(probeMap, 155, FOUR_PM, 90, null, 60)).toBe(true);
    // without the forgiveness parameter: the pre-fix false rejection
    expect(evaluateWindow(probeMap, 155, FOUR_PM, 90)).toBe(false);
  });

  it("still rejects 90 min at 4:30 PM — the 5:00 absence is inside the sound zone", () => {
    expect(evaluateWindow(probeMap, 155, FOUR_PM + 30, 90, null, 60)).toBe(false);
  });

  it("keeps the 2026-07-19 protection: a genuinely booked tail still rejects", () => {
    // Lane free [2:00, 3:15) only — next booking at 3:15 PM. QAMF stops
    // listing the offer from 2:30 (45 min left < 60). A 90-min pick at 2:00
    // must reject: the 2:30 absence is inside its sound zone (≤ 2:30).
    const T = 14 * 60;
    const booked: ProbeMap = new Map([
      [T, new Set([154])],
      [T + 15, new Set([154])],
      [T + 30, new Set<number>()],
      [T + 45, new Set<number>()],
      [T + 60, new Set<number>()],
      [T + 75, new Set<number>()],
    ]);
    expect(evaluateWindow(booked, 154, T, 90, null, 60)).toBe(false);
    // …while 60 min at 2:00 legitimately survives (fits before the booking —
    // its only sound-zone instant is the present 2:00 start).
    expect(evaluateWindow(booked, 154, T, 60, null, 60)).toBe(true);
  });

  it("a booking that starts EXACTLY at window end is not a conflict", () => {
    // Lane free [2:00, 3:30); next booking at 3:30. 90 min at 2:00 fits
    // exactly: instants 2:00–2:30 (sound zone) all present, 2:45+ artifacts.
    const T = 14 * 60;
    const exact: ProbeMap = new Map([
      [T, new Set([154])],
      [T + 15, new Set([154])],
      [T + 30, new Set([154])],
      [T + 45, new Set<number>()],
      [T + 60, new Set<number>()],
      [T + 75, new Set<number>()],
    ]);
    expect(evaluateWindow(exact, 154, T, 90, null, 60)).toBe(true);
  });
});

describe("tailForgiveMinutes", () => {
  it("caps at 60 when our config only knows longer options (vip-mon-thur 90/120)", () => {
    expect(tailForgiveMinutes(90)).toBe(60);
    expect(tailForgiveMinutes(null)).toBe(60);
  });

  it("a configured shorter option tightens the bound", () => {
    expect(tailForgiveMinutes(30)).toBe(30);
    expect(tailForgiveMinutes(60)).toBe(60);
  });
});

describe("windowCheckMinutes with tail forgiveness", () => {
  it("drops the window's start-tail instants (mirrors evaluateWindow)", () => {
    // 4:00 PM, 90 min, forgiveness 60 → only 4:15 and 4:30 are probed.
    expect(windowCheckMinutes(16 * 60, 90, null, 60)).toEqual([975, 990]);
    // no forgiveness → unchanged behavior
    expect(windowCheckMinutes(16 * 60, 90, null)).toEqual([975, 990, 1005, 1020, 1035]);
  });

  it("close clamp and tail forgiveness compose (tighter one wins)", () => {
    // 10:30 PM 90-min, last start 11:00 PM, forgiveness 60 → 10:45, 11:00.
    expect(windowCheckMinutes(22 * 60 + 30, 90, 23 * 60, 60)).toEqual([1365, 1380]);
  });
});
