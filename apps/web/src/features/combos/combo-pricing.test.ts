import { describe, expect, it } from "vitest";

import { buildRaceChargeLines } from "~/features/booking/service/checkout";
import type { RaceTier } from "~/features/booking/service/race-products";
import {
  emptySession,
  newItem,
  type BookingSession,
  type BowlingItem,
  type KbfItem,
  type PartyMember,
  type RaceHeatAssignment,
  type RaceItem,
} from "~/features/booking/state/types";

import {
  activeComboSpecial,
  comboChargeLines,
  comboItemizedLines,
  comboOrderGroups,
} from "./combo-pricing";

// June 2026: the 1st is a Monday; the 2nd is Mega Tuesday; the 6th a Saturday.
const MON = "2026-06-01";
const TUE = "2026-06-02";
const SAT = "2026-06-06";

// Real product ids so gate-failure fallbacks still build registry race lines.
const STARTER_RED = "24960859"; // weekday adult Starter Red
const MEGA = "43734407"; // existing adult Starter Mega

function member(id: string, over: Partial<PartyMember> = {}): PartyMember {
  return { id, firstName: id, isNewRacer: false, category: "adult", ...over };
}

/** Heat at an ET wall-clock time (BMI wall-clock-in-Z notation). */
function heat(date: string, time: string, assignedTo: string, tier: RaceTier): RaceHeatAssignment {
  return {
    productId: STARTER_RED,
    track: "Red",
    tier,
    category: "adult",
    heatId: `${date}T${time}:00Z`,
    bmiLineId: null,
    assignedTo,
  };
}

/** Starter @1 PM + Intermediate @4 PM for each racer. */
function itineraryHeats(date: string, racers: string[]): RaceHeatAssignment[] {
  return racers.flatMap((r) => [
    heat(date, "13:00", r, "starter"),
    heat(date, "16:00", r, "intermediate"),
  ]);
}

function raceItem(over: Partial<RaceItem> = {}): RaceItem {
  return {
    ...(newItem("race") as RaceItem),
    id: "race-1",
    date: MON,
    productIdAdult: MEGA,
    productTrackAdult: "Mega",
    ...over,
  };
}

/** 90-min VIP lane booked @2 PM ET (QAMF offset notation) — between the heats. */
function bowlingItem(date: string, over: Partial<BowlingItem> = {}): BowlingItem {
  return {
    ...(newItem("bowling") as BowlingItem),
    id: "bowl-1",
    date,
    bookedAt: `${date}T14:00:00-04:00`,
    variant: "hourly",
    tier: "vip",
    durationMinutes: 90,
    ...over,
  };
}

function comboSession(date = MON, over: Partial<BookingSession> = {}): BookingSession {
  return {
    ...emptySession({ entryBrand: "fasttrax" }),
    center: "fort-myers",
    comboSpecialId: "race-bowl",
    party: [member("a"), member("b")],
    items: [raceItem({ date, heats: itineraryHeats(date, ["a", "b"]) }), bowlingItem(date)],
    ...over,
  };
}

describe("activeComboSpecial — strict itinerary gate", () => {
  it("passes for starter + 90-min bowl between + intermediate, per racer", () => {
    const active = activeComboSpecial(comboSession());
    expect(active).not.toBeNull();
    expect(active!.combo.id).toBe("race-bowl");
    expect(active!.racerIds.sort()).toEqual(["a", "b"]);
  });

  it("falls back (null) when comboSpecialId is absent", () => {
    const s = comboSession();
    delete s.comboSpecialId;
    expect(activeComboSpecial(s)).toBeNull();
  });

  it("falls back when a racer is missing a leg (starter only)", () => {
    const s = comboSession();
    (s.items[0] as RaceItem).heats = [
      heat(MON, "13:00", "a", "starter"),
      ...itineraryHeats(MON, ["b"]),
    ];
    expect(activeComboSpecial(s)).toBeNull();
    expect(comboChargeLines(s)).toBeNull();
  });

  it("falls back on a wrong tier sequence (two starters)", () => {
    const s = comboSession();
    (s.items[0] as RaceItem).heats = ["a", "b"].flatMap((r) => [
      heat(MON, "13:00", r, "starter"),
      heat(MON, "16:00", r, "starter"),
    ]);
    expect(activeComboSpecial(s)).toBeNull();
  });

  it("falls back when the tiers run in the wrong ORDER (intermediate first)", () => {
    const s = comboSession();
    (s.items[0] as RaceItem).heats = ["a", "b"].flatMap((r) => [
      heat(MON, "13:00", r, "intermediate"),
      heat(MON, "16:00", r, "starter"),
    ]);
    expect(activeComboSpecial(s)).toBeNull();
  });

  it("falls back when bowling is not BETWEEN the races", () => {
    const s = comboSession();
    (s.items[1] as BowlingItem).bookedAt = `${MON}T11:00:00-04:00`; // before the starter
    expect(activeComboSpecial(s)).toBeNull();
    const s2 = comboSession();
    (s2.items[1] as BowlingItem).bookedAt = `${MON}T17:00:00-04:00`; // after the intermediate
    expect(activeComboSpecial(s2)).toBeNull();
  });

  it("falls back when a racer has an extra heat", () => {
    const s = comboSession();
    (s.items[0] as RaceItem).heats.push(heat(MON, "18:00", "a", "starter"));
    expect(activeComboSpecial(s)).toBeNull();
  });

  it("falls back when a heat is unassigned or unpicked", () => {
    const s = comboSession();
    (s.items[0] as RaceItem).heats[0] = { ...heat(MON, "13:00", "a", "starter"), assignedTo: null };
    expect(activeComboSpecial(s)).toBeNull();
    const s2 = comboSession();
    (s2.items[0] as RaceItem).heats[0] = { ...heat(MON, "13:00", "a", "starter"), heatId: null };
    expect(activeComboSpecial(s2)).toBeNull();
  });

  it("falls back when bowling is 60 minutes instead of 90", () => {
    const s = comboSession();
    (s.items[1] as BowlingItem).durationMinutes = 60;
    expect(activeComboSpecial(s)).toBeNull();
  });

  it("falls back when the lane is NOT VIP (the leg requires it)", () => {
    const s = comboSession();
    (s.items[1] as BowlingItem).tier = "regular";
    expect(activeComboSpecial(s)).toBeNull();
  });

  it("falls back when the bowling slot isn't booked yet", () => {
    const s = comboSession();
    (s.items[1] as BowlingItem).bookedAt = null;
    expect(activeComboSpecial(s)).toBeNull();
  });

  it("falls back when the bowling item is missing entirely", () => {
    const s = comboSession();
    s.items = s.items.filter((i) => i.kind !== "bowling");
    expect(activeComboSpecial(s)).toBeNull();
  });

  it("falls back when a KBF item is in the cart", () => {
    const s = comboSession();
    s.items = [...s.items, { ...(newItem("kbf") as KbfItem), id: "kbf-1" }];
    expect(activeComboSpecial(s)).toBeNull();
  });

  it("falls back at the wrong center", () => {
    const s = comboSession(MON, { center: "naples" });
    expect(activeComboSpecial(s)).toBeNull();
  });

  it("still passes with an extra attraction item (charged separately)", () => {
    const s = comboSession();
    s.items = [...s.items, newItem("attraction")];
    expect(activeComboSpecial(s)).not.toBeNull();
  });
});

/** Sum of a line set in cents. */
function sumCents(lines: Array<{ amount: number }>): number {
  return Math.round(lines.reduce((s, l) => s + l.amount, 0) * 100);
}

// 2 NEW racers (so license applies); MON weekday.
function newComboSession(date = MON): BookingSession {
  return comboSession(date, {
    party: [member("a", { isNewRacer: true }), member("b", { isNewRacer: true })],
    items: [raceItem({ date, heats: itineraryHeats(date, ["a", "b"]) }), bowlingItem(date)],
  });
}

describe("comboItemizedLines — Model A split (sums to the flat per-person price)", () => {
  it("2 new racers Mon–Thu: itemized to $65pp, routed to the right entities", () => {
    const lines = comboItemizedLines(newComboSession())!;
    const byKey = Object.fromEntries(lines.map((l) => [l.key, l]));
    expect(byKey["starter-race"]).toMatchObject({
      quantity: 2,
      unitCents: 1700,
      entity: "fasttrax-fm",
    });
    expect(byKey["intermediate-race"]).toMatchObject({ unitCents: 1700, entity: "fasttrax-fm" });
    expect(byKey["pov"]).toMatchObject({ unitCents: 500, entity: "fasttrax-fm" });
    expect(byKey["license"]).toMatchObject({ quantity: 2, unitCents: 499, entity: "fasttrax-fm" });
    expect(byKey["vip-bowling"]).toMatchObject({ unitCents: 1601, entity: "headpinz-fm" });
    expect(byKey["shoes"]).toMatchObject({ unitCents: 500, entity: "headpinz-fm" });
    // 2 × $65 = $130
    const total = lines.reduce((s, l) => s + l.unitCents * l.quantity, 0);
    expect(total).toBe(13000);
  });

  it("weekend uplift lands entirely on VIP bowling; racing flat", () => {
    const wd = comboItemizedLines(newComboSession(MON))!;
    const we = comboItemizedLines(newComboSession(SAT))!;
    const bowl = (ls: typeof wd) => ls.find((l) => l.key === "vip-bowling")!.unitCents;
    const race = (ls: typeof wd) => ls.find((l) => l.key === "starter-race")!.unitCents;
    expect(bowl(wd)).toBe(1601);
    expect(bowl(we)).toBe(2601); // +$10
    expect(race(wd)).toBe(race(we)); // racing unchanged
    expect(we.reduce((s, l) => s + l.unitCents * l.quantity, 0)).toBe(15000); // 2 × $75
  });

  it("Mega Tuesday prices as weekday", () => {
    expect(
      comboItemizedLines(newComboSession(TUE))!.reduce((s, l) => s + l.unitCents * l.quantity, 0),
    ).toBe(13000);
  });

  it("returning racer: license drops and rolls onto Starter Race (still $65pp)", () => {
    // a = new, b = returning.
    const s = comboSession(MON, {
      party: [member("a", { isNewRacer: true }), member("b", { isNewRacer: false })],
      items: [raceItem({ date: MON, heats: itineraryHeats(MON, ["a", "b"]) }), bowlingItem(MON)],
    });
    const lines = comboItemizedLines(s)!;
    // license only for the 1 new racer
    expect(lines.find((l) => l.key === "license")).toMatchObject({ quantity: 1, unitCents: 499 });
    // two Starter Race lines: $17.00 (new) + $21.99 (returning, license rolled in)
    const starters = lines.filter((l) => l.key === "starter-race");
    expect(starters.map((l) => l.unitCents).sort((x, y) => x - y)).toEqual([1700, 2199]);
    // still 2 × $65
    expect(lines.reduce((s, l) => s + l.unitCents * l.quantity, 0)).toBe(13000);
  });
});

describe("comboOrderGroups — one Square order per entity", () => {
  it("2 new racers Mon–Thu: FastTrax $87.98 + HeadPinz $42.04 = $130", () => {
    const groups = comboOrderGroups(newComboSession())!;
    const ft = groups.find((g) => g.entity === "fasttrax-fm")!;
    const hp = groups.find((g) => g.entity === "headpinz-fm")!;
    expect(ft.subtotalCents).toBe(8798); // 2×(1700+1700+500+499)
    expect(hp.subtotalCents).toBe(4202); // 2×(1601+500)
    expect(ft.subtotalCents + hp.subtotalCents).toBe(13000);
    // every line carries a real catalog variation id
    for (const g of groups)
      for (const l of g.lines) expect(l.catalogObjectId).toMatch(/^[A-Z0-9]{20,}$/);
  });

  it("weekend: HeadPinz carries the uplift ($62.02), FastTrax unchanged ($87.98)", () => {
    const groups = comboOrderGroups(newComboSession(SAT))!;
    expect(groups.find((g) => g.entity === "fasttrax-fm")!.subtotalCents).toBe(8798);
    expect(groups.find((g) => g.entity === "headpinz-fm")!.subtotalCents).toBe(6202); // 2×(2601+500)
  });
});

describe("buildRaceChargeLines — combo integration (display == charge seam)", () => {
  it("combo session: itemized lines REPLACE the race product lines, no separate license/POV", () => {
    const lines = buildRaceChargeLines(newComboSession());
    const names = lines.map((l) => l.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "VIP Exp - Starter Race",
        "VIP Exp - Intermediate Race",
        "VIP Exp - POV Video",
        "VIP Exp - FastTrax License",
        "VIP Exp - VIP Bowling",
        "VIP Exp - Shoes",
      ]),
    );
    // No on-top license beyond the combo's own; no legacy POV line.
    expect(names.filter((n) => n === "VIP Exp - FastTrax License")).toHaveLength(1);
    expect(names).not.toContain("POV Race Video");
    // Total = 2 × $65 = $130.
    expect(sumCents(lines)).toBe(13000);
  });

  it("gate failure falls back to normal item-sum race lines", () => {
    const s = newComboSession();
    (s.items[1] as BowlingItem).durationMinutes = 60; // breaks the gate
    const names = buildRaceChargeLines(s).map((l) => l.name);
    expect(names).not.toContain("VIP Exp - VIP Bowling");
    expect(names.length).toBeGreaterThan(0);
  });

  it("is deterministic — two calls byte-identical (display === charge)", () => {
    const s = newComboSession();
    expect(JSON.stringify(buildRaceChargeLines(s))).toBe(JSON.stringify(buildRaceChargeLines(s)));
  });
});
