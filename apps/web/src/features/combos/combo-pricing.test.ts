import { describe, expect, it } from "vitest";

import { buildRaceChargeLines } from "~/features/booking/service/checkout";
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

// Existing adult Starter Mega product (same id the sibling charge tests use).
const MEGA = "43734407";

function member(id: string, over: Partial<PartyMember> = {}): PartyMember {
  return { id, firstName: id, isNewRacer: false, category: "adult", ...over };
}

function heat(heatId: string, assignedTo: string): RaceHeatAssignment {
  return {
    productId: MEGA,
    track: "Mega",
    tier: "starter",
    category: "adult",
    heatId,
    bmiLineId: null,
    assignedTo,
  };
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

function bowlingItem(over: Partial<BowlingItem> = {}): BowlingItem {
  return {
    ...(newItem("bowling") as BowlingItem),
    id: "bowl-1",
    date: MON,
    bookedAt: `${MON}T18:00:00-04:00`,
    variant: "hourly",
    durationMinutes: 90,
    ...over,
  };
}

/** Two racers (a + b), each with exactly 2 heats, plus a 90-min bowling slot. */
function comboSession(over: Partial<BookingSession> = {}): BookingSession {
  const date = (over.items?.find((i) => i.kind === "race") as RaceItem | undefined)?.date ?? MON;
  return {
    ...emptySession({ entryBrand: "fasttrax" }),
    center: "fort-myers",
    comboSpecialId: "race-bowl",
    party: [member("a"), member("b")],
    items: [
      raceItem({
        date,
        heats: [heat("T1", "a"), heat("T2", "a"), heat("T1", "b"), heat("T2", "b")],
      }),
      bowlingItem({ date, bookedAt: `${date}T18:00:00-04:00` }),
    ],
    ...over,
  };
}

describe("activeComboSpecial — strict gate", () => {
  it("passes for exactly 2 heats/racer + 90-min bowling at Fort Myers", () => {
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

  it("falls back when a racer has only 1 heat", () => {
    const s = comboSession();
    (s.items[0] as RaceItem).heats = [heat("T1", "a"), heat("T1", "b"), heat("T2", "b")];
    expect(activeComboSpecial(s)).toBeNull();
    expect(comboChargeLines(s)).toBeNull();
  });

  it("falls back when a racer has 3 heats", () => {
    const s = comboSession();
    (s.items[0] as RaceItem).heats.push(heat("T3", "a"));
    expect(activeComboSpecial(s)).toBeNull();
  });

  it("falls back when a heat is unassigned or unpicked", () => {
    const s = comboSession();
    (s.items[0] as RaceItem).heats[0] = { ...heat("T1", "a"), assignedTo: null };
    expect(activeComboSpecial(s)).toBeNull();
    const s2 = comboSession();
    (s2.items[0] as RaceItem).heats[0] = { ...heat("T1", "a"), heatId: null };
    expect(activeComboSpecial(s2)).toBeNull();
  });

  it("falls back when bowling is 60 minutes instead of 90", () => {
    const s = comboSession();
    (s.items[1] as BowlingItem).durationMinutes = 60;
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
    const s = comboSession({ center: "naples" });
    expect(activeComboSpecial(s)).toBeNull();
  });

  it("still passes with an extra attraction item (charged separately)", () => {
    const s = comboSession();
    s.items = [...s.items, newItem("attraction")];
    expect(activeComboSpecial(s)).not.toBeNull();
  });
});

describe("comboChargeLines — flat per-person pricing", () => {
  it("Mon–Thu: one line, $65/person × 2 racers = $130", () => {
    const lines = comboChargeLines(comboSession())!;
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ name: "Race + Bowl Combo", quantity: 2, amount: 130 });
    expect(lines[0].time).toBe("T1");
  });

  it("Mega Tuesday prices as weekday ($65)", () => {
    const lines = comboChargeLines(comboSession({ items: comboSession().items }))!;
    const tue = comboChargeLines(
      comboSession({
        items: [
          raceItem({
            date: TUE,
            heats: [heat("T1", "a"), heat("T2", "a"), heat("T1", "b"), heat("T2", "b")],
          }),
          bowlingItem({ date: TUE, bookedAt: `${TUE}T18:00:00-04:00` }),
        ],
      }),
    )!;
    expect(lines[0].amount).toBe(130);
    expect(tue[0].amount).toBe(130);
  });

  it("Fri–Sun: $75/person × 2 racers = $150", () => {
    const lines = comboChargeLines(
      comboSession({
        items: [
          raceItem({
            date: SAT,
            heats: [heat("T1", "a"), heat("T2", "a"), heat("T1", "b"), heat("T2", "b")],
          }),
          bowlingItem({ date: SAT, bookedAt: `${SAT}T18:00:00-04:00` }),
        ],
      }),
    )!;
    expect(lines).toHaveLength(1);
    expect(lines[0].amount).toBe(150);
  });

  it("splits per racer membership discount — full-price line first", () => {
    const s = comboSession({
      party: [member("a", { memberships: ["Employee Pass"] }), member("b")],
    });
    const lines = comboChargeLines(s)!;
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ name: "Race + Bowl Combo", quantity: 1, amount: 65 });
    expect(lines[1]).toMatchObject({
      name: "Race + Bowl Combo (Employee Pass −50%)",
      quantity: 1,
      amount: 32.5,
      membershipDiscountPct: 50,
    });
  });
});

describe("buildRaceChargeLines — combo integration (the single display==charge seam)", () => {
  it("combo session: combo line REPLACES the race product lines", () => {
    const lines = buildRaceChargeLines(comboSession());
    expect(lines.map((l) => l.name)).toEqual(["Race + Bowl Combo"]);
    expect(lines[0].amount).toBe(130);
  });

  it("license still charges on top for new racers (not a combo component)", () => {
    const s = comboSession({
      party: [member("a", { isNewRacer: true }), member("b")],
    });
    const names = buildRaceChargeLines(s).map((l) => l.name);
    expect(names).toContain("Race + Bowl Combo");
    expect(names).toContain("FastTrax License");
  });

  it("gate failure falls back to normal item-sum race lines", () => {
    const s = comboSession();
    (s.items[1] as BowlingItem).durationMinutes = 60; // breaks the gate
    const names = buildRaceChargeLines(s).map((l) => l.name);
    expect(names).not.toContain("Race + Bowl Combo");
    expect(names.length).toBeGreaterThan(0); // the regular race product line(s)
  });

  it("is deterministic — two calls produce byte-identical output (display === charge)", () => {
    const s = comboSession({
      party: [member("a", { memberships: ["Employee Pass"] }), member("b", { isNewRacer: true })],
    });
    expect(JSON.stringify(buildRaceChargeLines(s))).toBe(JSON.stringify(buildRaceChargeLines(s)));
  });
});
