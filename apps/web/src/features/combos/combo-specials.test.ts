import { describe, expect, it } from "vitest";

import {
  COMBO_SPECIALS,
  comboAvailableOn,
  comboBowlingComponent,
  comboMinHeadcount,
  comboReorderFallbackEnabled,
  comboReservationNote,
  comboHeatsPerRacer,
  comboPriceCentsForDate,
  comboRaceLegs,
  comboStartHoursLabel,
  comboTotalCents,
  enabledCombos,
  getComboSpecial,
  legKey,
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
  it("race-bowl is the locked VIP itinerary: starter → 90-min VIP bowl → intermediate", () => {
    expect(raceBowl).not.toBeNull();
    expect(raceBowl.name).toBe("Ultimate VIP Experience");
    expect(raceBowl.center).toBe("fort-myers");
    expect(raceBowl.price).toEqual({ weekday: 6500, weekend: 7500 });
    expect(raceBowl.components).toEqual([
      { kind: "race", tier: "starter" },
      // Owner: the lane must start within 60 minutes of the first race.
      { kind: "bowling", durationMinutes: 90, vip: true, maxWaitMinutes: 60 },
      { kind: "race", tier: "intermediate" },
    ]);
    expect(raceBowl.transitionMinutes).toBe(15);
    // Owner: the pack INCLUDES the racing license and one POV per racer.
    expect(raceBowl.includesLicense).toBe(true);
    expect(raceBowl.includedPovPerRacer).toBe(1);
    // Premium presentation + the fixed 2/4/6/8/10 PM start grid.
    expect(raceBowl.premium).toBe(true);
    expect(raceBowl.startHours).toEqual([14, 16, 18, 20, 22]);
    expect(comboStartHoursLabel(raceBowl)).toBe("2 · 4 · 6 · 8 · 10 PM");
    expect(raceBowl.perks?.length).toBeGreaterThan(0);
  });

  it("the VIP experience requires at least 2 people (shared semi-private suite)", () => {
    expect(raceBowl.minHeadcount).toBe(2);
    expect(comboMinHeadcount(raceBowl)).toBe(2);
  });

  it("comboMinHeadcount defaults to 1 when a combo sets no minimum", () => {
    expect(comboMinHeadcount({ ...raceBowl, minHeadcount: undefined })).toBe(1);
  });

  it("leg helpers read the ordered itinerary", () => {
    expect(comboRaceLegs(raceBowl).map((l) => l.tier)).toEqual(["starter", "intermediate"]);
    expect(comboBowlingComponent(raceBowl)).toEqual({
      kind: "bowling",
      durationMinutes: 90,
      vip: true,
      maxWaitMinutes: 60,
    });
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

  it("comboReservationNote tells ops it's VIP, what's prepaid, the plan, and the lane", () => {
    const memo = comboReservationNote(raceBowl, "28");
    expect(memo).toContain("ULTIMATE VIP EXPERIENCE (VIP COMBO)");
    expect(memo).toContain("racing license + POV video + VIP lane perks + shoes INCLUDED");
    expect(memo).toContain("1) Starter Race");
    expect(memo).toContain("2) 1.5hr VIP Bowling at HeadPinz — Lane 28");
    expect(memo).toContain("3) Intermediate Race (ONLY IF QUALIFIED)");
    expect(memo).toContain("Bowling lane: 28");
    expect(memo).toContain(
      "convert their later race to a second Starter race OR issue a race credit",
    );
    expect(memo).toContain("settles at lane-open");
  });

  it("comboReservationNote omits the lane line when none is assigned yet", () => {
    const memo = comboReservationNote(raceBowl, null);
    expect(memo).not.toContain("Lane");
    expect(memo).toContain("ULTIMATE VIP EXPERIENCE (VIP COMBO)");
  });

  it("comboReservationNote renders the reorder order when given fallbackComponents", () => {
    const memo = comboReservationNote(raceBowl, "28", raceBowl.fallbackComponents);
    // race → race → bowl (lane last), not the default race → bowl → race.
    expect(memo).toContain("1) Starter Race");
    expect(memo).toContain("2) Intermediate Race (ONLY IF QUALIFIED)");
    expect(memo).toContain("3) 1.5hr VIP Bowling at HeadPinz — Lane 28");
  });
});

describe("reorder fallback registry", () => {
  it("race-bowl carries a race → race → bowl fallback with bounded gaps", () => {
    expect(raceBowl.fallbackComponents).toEqual([
      { kind: "race", tier: "starter" },
      { kind: "race", tier: "intermediate", minWaitMinutes: 20, maxWaitMinutes: 45 },
      { kind: "bowling", durationMinutes: 90, vip: true, maxWaitMinutes: 45 },
    ]);
    expect(raceBowl.fallbackNote).toBeTruthy();
  });

  it("the fallback shares leg 0 (Starter) with the primary order — same start time", () => {
    expect(legKey(raceBowl.components[0])).toBe(legKey(raceBowl.fallbackComponents![0]));
  });

  it("legKey is a stable per-leg identity", () => {
    expect(legKey({ kind: "race", tier: "starter" })).toBe("race:starter");
    expect(legKey({ kind: "race", tier: "intermediate" })).toBe("race:intermediate");
    expect(legKey({ kind: "bowling", durationMinutes: 90, vip: true })).toBe("bowl:90:vip");
    expect(legKey({ kind: "bowling", durationMinutes: 60 })).toBe("bowl:60:reg");
  });

  it("ships dark — reorder fallback is OFF unless the flag is 'true'", () => {
    expect(comboReorderFallbackEnabled()).toBe(false);
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
