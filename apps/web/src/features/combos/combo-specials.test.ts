import { describe, expect, it } from "vitest";

import {
  COMBO_SPECIALS,
  comboAvailableOn,
  comboBowlingComponent,
  comboHeatsPerRacer,
  comboPriceCentsForDate,
  comboRaceLegs,
  comboTotalCents,
  enabledCombos,
  getComboSpecial,
  type ComboSpecial,
} from "./combo-specials";

// June 2026: the 1st is a Monday.
const MON = "2026-06-01";
const TUE = "2026-06-02"; // Mega Tuesday
const THU = "2026-06-04";
const FRI = "2026-06-05";
const SAT = "2026-06-06";
const SUN = "2026-06-07";

const raceBowl = getComboSpecial("race-bowl")!;

describe("combo-specials registry", () => {
  it("race-bowl is the locked guided itinerary: starter → 90-min bowl → intermediate", () => {
    expect(raceBowl).not.toBeNull();
    expect(raceBowl.center).toBe("fort-myers");
    expect(raceBowl.price).toEqual({ weekday: 6500, weekend: 7500 });
    expect(raceBowl.components).toEqual([
      { kind: "race", tier: "starter" },
      { kind: "bowling", durationMinutes: 90 },
      { kind: "race", tier: "intermediate" },
    ]);
    expect(raceBowl.transitionMinutes).toBe(15);
  });

  it("leg helpers read the ordered itinerary", () => {
    expect(comboRaceLegs(raceBowl).map((l) => l.tier)).toEqual(["starter", "intermediate"]);
    expect(comboBowlingComponent(raceBowl)).toEqual({ kind: "bowling", durationMinutes: 90 });
    expect(comboHeatsPerRacer(raceBowl)).toBe(2);
  });

  it("ids are unique kebab slugs", () => {
    const ids = COMBO_SPECIALS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  it("getComboSpecial returns null for unknown ids", () => {
    expect(getComboSpecial("nope")).toBeNull();
  });

  it("enabledCombos respects displayOrder", () => {
    const orders = enabledCombos().map((c) => c.displayOrder ?? 0);
    expect([...orders].sort((a, b) => a - b)).toEqual(orders);
  });
});

describe("comboPriceCentsForDate — day tiers", () => {
  it("Mon–Thu → weekday 6500", () => {
    expect(comboPriceCentsForDate(raceBowl, MON)).toBe(6500);
    expect(comboPriceCentsForDate(raceBowl, THU)).toBe(6500);
  });

  it("Mega Tuesday → weekday 6500 (locked decision)", () => {
    expect(comboPriceCentsForDate(raceBowl, TUE)).toBe(6500);
  });

  it("Fri/Sat/Sun → weekend 7500", () => {
    expect(comboPriceCentsForDate(raceBowl, FRI)).toBe(7500);
    expect(comboPriceCentsForDate(raceBowl, SAT)).toBe(7500);
    expect(comboPriceCentsForDate(raceBowl, SUN)).toBe(7500);
  });

  it("comboTotalCents = per-person × headcount", () => {
    expect(comboTotalCents(raceBowl, MON, 2)).toBe(13000);
    expect(comboTotalCents(raceBowl, SAT, 3)).toBe(22500);
    expect(comboTotalCents(raceBowl, SAT, 0)).toBe(0);
  });
});

describe("comboAvailableOn — availability windows", () => {
  const windowed: ComboSpecial = {
    ...raceBowl,
    id: "windowed",
    availability: {
      startsAt: "2026-06-01",
      expiresAt: "2026-06-30",
      allowedWeekdays: [1, 2, 3, 4],
    },
  };

  it("no availability → always on", () => {
    expect(comboAvailableOn(raceBowl, MON)).toBe(true);
  });

  it("inside window + allowed weekday → on", () => {
    expect(comboAvailableOn(windowed, MON)).toBe(true);
  });

  it("outside date window → off", () => {
    expect(comboAvailableOn(windowed, "2026-05-31")).toBe(false);
    expect(comboAvailableOn(windowed, "2026-07-01")).toBe(false);
  });

  it("disallowed weekday → off (Sat is day 6, not in [1..4])", () => {
    expect(comboAvailableOn(windowed, SAT)).toBe(false);
  });
});
