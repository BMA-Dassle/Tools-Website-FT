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
import type { AppliedPromo } from "~/features/discount-codes";

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

  it("falls back when bowling is before the FIRST race (no valid ordering)", () => {
    const s = comboSession();
    (s.items[1] as BowlingItem).bookedAt = `${MON}T11:00:00-04:00`; // before the starter
    expect(activeComboSpecial(s)).toBeNull();
  });

  it("accepts bowling AFTER both races (reorder fallback: race → race → bowl)", () => {
    const s = comboSession();
    (s.items[1] as BowlingItem).bookedAt = `${MON}T17:00:00-04:00`; // after the intermediate
    const active = activeComboSpecial(s);
    expect(active).not.toBeNull();
    expect(active!.racerIds.sort()).toEqual(["a", "b"]);
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

describe("comboItemizedLines — collapsed per-center split (sums to the flat per-person price)", () => {
  it("2 new racers Mon–Thu: ONE VIP line per center, sums to $65pp", () => {
    const lines = comboItemizedLines(newComboSession())!;
    expect(lines).toHaveLength(2); // one per center, no itemized parts
    const byKey = Object.fromEntries(lines.map((l) => [l.key, l]));
    expect(byKey["vip-racing"]).toMatchObject({
      quantity: 2,
      unitCents: 4400,
      entity: "fasttrax-fm",
      name: "Ultimate VIP Experience",
    });
    expect(byKey["vip-bowling"]).toMatchObject({
      quantity: 2,
      unitCents: 2100,
      entity: "headpinz-fm",
      name: "Ultimate VIP Experience",
    });
    // 2 × $65 = $130
    const total = lines.reduce((s, l) => s + l.unitCents * l.quantity, 0);
    expect(total).toBe(13000);
  });

  it("weekend uplift is SHARED: both centers rise $5pp", () => {
    const wd = comboItemizedLines(newComboSession(MON))!;
    const we = comboItemizedLines(newComboSession(SAT))!;
    const racing = (ls: typeof wd) => ls.find((l) => l.key === "vip-racing")!.unitCents;
    const bowling = (ls: typeof wd) => ls.find((l) => l.key === "vip-bowling")!.unitCents;
    expect(racing(wd)).toBe(4400);
    expect(racing(we)).toBe(4900); // +$5
    expect(bowling(wd)).toBe(2100);
    expect(bowling(we)).toBe(2600); // +$5
    expect(we.reduce((s, l) => s + l.unitCents * l.quantity, 0)).toBe(15000); // 2 × $75
  });

  it("Mega Tuesday prices as weekday", () => {
    expect(
      comboItemizedLines(newComboSession(TUE))!.reduce((s, l) => s + l.unitCents * l.quantity, 0),
    ).toBe(13000);
  });

  it("returning racer pays the same flat split — no per-racer itemization", () => {
    // a = new, b = returning. The collapsed bundle no longer reallocates a
    // per-racer license line; everyone shows the same two center lines.
    const s = comboSession(MON, {
      party: [member("a", { isNewRacer: true }), member("b", { isNewRacer: false })],
      items: [raceItem({ date: MON, heats: itineraryHeats(MON, ["a", "b"]) }), bowlingItem(MON)],
    });
    const lines = comboItemizedLines(s)!;
    expect(lines).toHaveLength(2);
    expect(lines.find((l) => l.key === "vip-racing")).toMatchObject({
      quantity: 2,
      unitCents: 4400,
    });
    expect(lines.find((l) => l.key === "vip-bowling")).toMatchObject({
      quantity: 2,
      unitCents: 2100,
    });
    // still 2 × $65
    expect(lines.reduce((s, l) => s + l.unitCents * l.quantity, 0)).toBe(13000);
  });
});

describe("comboOrderGroups — one Square order per entity", () => {
  it("2 new racers Mon–Thu: FastTrax $88.00 + HeadPinz $42.00 = $130", () => {
    const groups = comboOrderGroups(newComboSession())!;
    const ft = groups.find((g) => g.entity === "fasttrax-fm")!;
    const hp = groups.find((g) => g.entity === "headpinz-fm")!;
    expect(ft.lines).toHaveLength(1); // one collapsed line per order
    expect(hp.lines).toHaveLength(1);
    expect(ft.subtotalCents).toBe(8800); // 2 × $44
    expect(hp.subtotalCents).toBe(4200); // 2 × $21
    expect(ft.subtotalCents + hp.subtotalCents).toBe(13000);
    // every line carries a real catalog variation id
    for (const g of groups)
      for (const l of g.lines) expect(l.catalogObjectId).toMatch(/^[A-Z0-9]{20,}$/);
  });

  it("weekend: BOTH centers carry the uplift (FastTrax $98.00, HeadPinz $52.00)", () => {
    const groups = comboOrderGroups(newComboSession(SAT))!;
    expect(groups.find((g) => g.entity === "fasttrax-fm")!.subtotalCents).toBe(9800); // 2 × $49
    expect(groups.find((g) => g.entity === "headpinz-fm")!.subtotalCents).toBe(5200); // 2 × $26
  });
});

describe("buildRaceChargeLines — combo integration (display == charge seam)", () => {
  it("combo session: ONE VIP line per center REPLACES the race product lines", () => {
    const lines = buildRaceChargeLines(newComboSession());
    const names = lines.map((l) => l.name);
    // Two collapsed lines, both the experience name (one per center).
    expect(names.filter((n) => n === "Ultimate VIP Experience")).toHaveLength(2);
    // No itemized parts, no legacy prefix, no separate license/POV.
    expect(names.some((n) => n.startsWith("VIP Exp - "))).toBe(false);
    expect(names).not.toContain("POV Race Video");
    expect(names).not.toContain("FastTrax License");
    // Total = 2 × $65 = $130.
    expect(sumCents(lines)).toBe(13000);
  });

  it("gate failure falls back to normal item-sum race lines", () => {
    const s = newComboSession();
    (s.items[1] as BowlingItem).durationMinutes = 60; // breaks the gate
    const names = buildRaceChargeLines(s).map((l) => l.name);
    expect(names).not.toContain("Ultimate VIP Experience");
    expect(names.length).toBeGreaterThan(0);
  });

  it("is deterministic — two calls byte-identical (display === charge)", () => {
    const s = newComboSession();
    expect(JSON.stringify(buildRaceChargeLines(s))).toBe(JSON.stringify(buildRaceChargeLines(s)));
  });
});

// FREEDOM250 — 25% off, valid only for a specific visit date. `bookingDate*` is
// pinned to the session's date so the test is independent of the wall-clock
// `now` used inside the seam (wide purchase window covers any run date).
function promoFor(ymd: string): AppliedPromo {
  return {
    code: "FREEDOM250TEST",
    domains: ["racing", "bowling", "attractions"],
    scopes: {
      racing: { productSlugs: null },
      bowling: { experienceSlugs: null },
      attractions: { slugs: null },
    },
    startsAt: "2024-01-01T00:00:00Z",
    expiresAt: "2030-01-01T00:00:00Z",
    allowedWeekdays: null,
    bookingDateStart: ymd,
    bookingDateEnd: ymd,
    mechanic: "percent",
    amountPct: 25,
    amountCents: null,
    squareCatalogId: null,
  };
}

describe("FREEDOM250 — combo reduction (owner: combos DO get the discount)", () => {
  it("reduces BOTH split-order entities 25% on an eligible visit date", () => {
    const s = newComboSession(SAT); // weekend: racing 4900 + bowling 2600 = $75pp
    s.appliedPromo = promoFor(SAT);
    const lines = comboItemizedLines(s)!;
    const racing = lines.find((l) => l.key === "vip-racing")!;
    const bowling = lines.find((l) => l.key === "vip-bowling")!;
    expect(racing.unitCents).toBe(3675); // round(4900 * 0.75)
    expect(racing.originalUnitCents).toBe(4900);
    expect(bowling.unitCents).toBe(1950); // round(2600 * 0.75)
    expect(bowling.originalUnitCents).toBe(2600);

    // The split orders inherit the reduction (one shared seam → both agree).
    const groups = comboOrderGroups(s)!;
    const ft = groups.find((g) => g.entity === "fasttrax-fm")!;
    const hp = groups.find((g) => g.entity === "headpinz-fm")!;
    expect(ft.subtotalCents).toBe(7350); // 2 × 3675
    expect(hp.subtotalCents).toBe(3900); // 2 × 1950
    expect(ft.subtotalCents + hp.subtotalCents).toBe(11250); // 0.75 × $150
  });

  it("buildRaceChargeLines stamps originalAmount + promoPct for the strikethrough", () => {
    const s = newComboSession(SAT);
    s.appliedPromo = promoFor(SAT);
    const racing = buildRaceChargeLines(s).find(
      (l) => l.name === "Ultimate VIP Experience" && l.comboEntity === "fasttrax-fm",
    )!;
    expect(racing.amount).toBeCloseTo(73.5, 2); // 2 × $36.75
    expect(racing.originalAmount).toBeCloseTo(98.0, 2); // 2 × $49.00
    expect(racing.promoPct).toBe(25);
    expect(sumCents(buildRaceChargeLines(s))).toBe(11250);
  });

  it("does NOT reduce a combo whose date is outside the promo window", () => {
    const s = newComboSession(SAT);
    s.appliedPromo = promoFor("2026-07-04"); // promo is for a different day
    const racing = comboItemizedLines(s)!.find((l) => l.key === "vip-racing")!;
    expect(racing.unitCents).toBe(4900); // unchanged
    expect(racing.originalUnitCents).toBeUndefined();
  });
});

describe("FREEDOM250 — non-combo race reduction via buildRaceChargeLines", () => {
  function raceOnlySession(date: string, promo: AppliedPromo | null): BookingSession {
    return {
      ...emptySession({ entryBrand: "fasttrax" }),
      center: "fort-myers",
      party: [member("a")], // returning racer → no license line
      items: [raceItem({ date, heats: [heat(date, "13:00", "a", "starter")] })],
      appliedPromo: promo,
    };
  }

  it("reduces an eligible race line 25% and stamps the original", () => {
    const race = buildRaceChargeLines(raceOnlySession(SAT, promoFor(SAT))).find(
      (l) => l.domain === "racing",
    )!;
    expect(race.originalAmount).toBeGreaterThan(0);
    expect(race.amount).toBeCloseTo(Math.round(race.originalAmount! * 0.75 * 100) / 100, 2);
    expect(race.promoPct).toBe(25);
  });

  it("leaves race lines full price when the visit date is outside the window", () => {
    const race = buildRaceChargeLines(raceOnlySession(SAT, promoFor("2026-07-04"))).find(
      (l) => l.domain === "racing",
    )!;
    expect(race.originalAmount).toBeUndefined();
  });
});
