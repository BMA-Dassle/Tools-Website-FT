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

import { activeComboSpecial, comboChargeLines } from "./combo-pricing";

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

describe("comboChargeLines — flat per-person pricing", () => {
  it("Mon–Thu: one line, $65/person × 2 racers = $130, timed at the starter", () => {
    const lines = comboChargeLines(comboSession())!;
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ name: "Ultimate VIP Experience", quantity: 2, amount: 130 });
    expect(lines[0].time).toBe(`${MON}T13:00:00Z`);
  });

  it("Mega Tuesday prices as weekday ($65)", () => {
    const lines = comboChargeLines(comboSession(TUE))!;
    expect(lines[0].amount).toBe(130);
  });

  it("Fri–Sun: $75/person × 2 racers = $150", () => {
    const lines = comboChargeLines(comboSession(SAT))!;
    expect(lines).toHaveLength(1);
    expect(lines[0].amount).toBe(150);
  });

  it("splits per racer membership discount — full-price line first", () => {
    const s = comboSession(MON, {
      party: [member("a", { memberships: ["Employee Pass"] }), member("b")],
      items: [raceItem({ date: MON, heats: itineraryHeats(MON, ["a", "b"]) }), bowlingItem(MON)],
    });
    const lines = comboChargeLines(s)!;
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ name: "Ultimate VIP Experience", quantity: 1, amount: 65 });
    expect(lines[1]).toMatchObject({
      name: "Ultimate VIP Experience (Employee Pass −50%)",
      quantity: 1,
      amount: 32.5,
      membershipDiscountPct: 50,
    });
  });
});

describe("buildRaceChargeLines — combo integration (the single display==charge seam)", () => {
  it("combo session: combo line REPLACES the race product lines", () => {
    const lines = buildRaceChargeLines(comboSession());
    expect(lines.map((l) => l.name)).toEqual(["Ultimate VIP Experience"]);
    expect(lines[0].amount).toBe(130);
  });

  it("license is INCLUDED — no separate Square line even with new racers", () => {
    const s = comboSession(MON, {
      party: [member("a", { isNewRacer: true }), member("b")],
      items: [raceItem({ date: MON, heats: itineraryHeats(MON, ["a", "b"]) }), bowlingItem(MON)],
    });
    const names = buildRaceChargeLines(s).map((l) => l.name);
    expect(names).toContain("Ultimate VIP Experience");
    expect(names).not.toContain("FastTrax License");
  });

  it("included POV (1/racer) is absorbed — no Square POV line for the auto-set quantity", () => {
    const s = comboSession();
    (s.items[0] as RaceItem).povQuantity = 2; // combo flow auto-sets racers × 1
    const names = buildRaceChargeLines(s).map((l) => l.name);
    expect(names).toContain("Ultimate VIP Experience");
    expect(names).not.toContain("POV Race Video");
  });

  it("POV beyond the included count would still charge (defensive)", () => {
    const s = comboSession();
    (s.items[0] as RaceItem).povQuantity = 3; // one more than included (2 racers × 1)
    const pov = buildRaceChargeLines(s).find((l) => l.name === "POV Race Video");
    expect(pov).toMatchObject({ quantity: 1 });
  });

  it("gate failure falls back to normal item-sum race lines", () => {
    const s = comboSession();
    (s.items[1] as BowlingItem).durationMinutes = 60; // breaks the gate
    const names = buildRaceChargeLines(s).map((l) => l.name);
    expect(names).not.toContain("Ultimate VIP Experience");
    expect(names.length).toBeGreaterThan(0); // the regular race product line(s)
  });

  it("is deterministic — two calls produce byte-identical output (display === charge)", () => {
    const s = comboSession(MON, {
      party: [member("a", { memberships: ["Employee Pass"] }), member("b", { isNewRacer: true })],
      items: [raceItem({ date: MON, heats: itineraryHeats(MON, ["a", "b"]) }), bowlingItem(MON)],
    });
    expect(JSON.stringify(buildRaceChargeLines(s))).toBe(JSON.stringify(buildRaceChargeLines(s)));
  });
});
