import { describe, expect, it } from "vitest";
import { autoAssignRaces, type AutoFillMember } from "./race-autofill";
import type { CheckinRaceSlot } from "./types";

const slot = (
  key: string,
  category: "adult" | "junior",
  heatId: string,
  track = "Red",
): CheckinRaceSlot => ({
  slotKey: key,
  heatId,
  productId: null,
  classLabel: `${category} GP`,
  tier: "grand-prix",
  category,
  track,
  timeLabel: heatId.slice(11, 16),
  occupantName: null,
  open: true,
});

const m = (id: string, category: "adult" | "junior" | null = "adult"): AutoFillMember => ({
  id,
  category,
});

/** Same shape as the picker's rule: same track within 45 minutes is too close. */
const conflicts = (a: CheckinRaceSlot, b: CheckinRaceSlot) => {
  const gap = Math.abs(Date.parse(a.heatId) - Date.parse(b.heatId)) / 60000;
  return gap < 45;
};
const never = () => false;

describe("autoAssignRaces — the counts line up", () => {
  it("fills a clean 3 racers / 3 adult seats", () => {
    const slots = [
      slot("s1", "adult", "2026-08-07T19:00:00"),
      slot("s2", "adult", "2026-08-07T20:00:00"),
      slot("s3", "adult", "2026-08-07T21:00:00"),
    ];
    const out = autoAssignRaces({ slots, members: [m("a"), m("b"), m("c")], conflicts });
    expect(Object.keys(out)).toHaveLength(3);
    expect(new Set(Object.values(out))).toEqual(new Set(["a", "b", "c"]));
  });

  it("seats each racer once per heat on a multi-heat booking (the W57387 shape)", () => {
    // 6 racers, two heats an hour apart = 12 seats.
    const slots = [
      ...Array.from({ length: 6 }, (_, i) => slot(`h1-${i}`, "adult", "2026-08-07T19:12:00")),
      ...Array.from({ length: 6 }, (_, i) => slot(`h2-${i}`, "adult", "2026-08-07T20:12:00")),
    ];
    const members = ["a", "b", "c", "d", "e", "f"].map((id) => m(id));
    const out = autoAssignRaces({ slots, members, conflicts });
    expect(Object.keys(out)).toHaveLength(12);
    // Everyone gets exactly two seats, one in each heat.
    const counts = new Map<string, number>();
    for (const id of Object.values(out)) counts.set(id, (counts.get(id) ?? 0) + 1);
    expect([...counts.values()]).toEqual([2, 2, 2, 2, 2, 2]);
  });
});

describe("autoAssignRaces — refuses to guess", () => {
  it("leaves a category BLANK when more racers than seats", () => {
    const slots = [slot("s1", "adult", "2026-08-07T19:00:00")];
    const out = autoAssignRaces({ slots, members: [m("a"), m("b")], conflicts });
    expect(out).toEqual({});
  });

  it("still fills the other category when one is ambiguous", () => {
    const slots = [
      slot("adultSeat", "adult", "2026-08-07T19:00:00"),
      slot("juniorSeat", "junior", "2026-08-07T19:30:00", "Blue"),
    ];
    const out = autoAssignRaces({
      slots,
      members: [m("a1"), m("a2"), m("j1", "junior")],
      conflicts,
    });
    expect(out).toEqual({ juniorSeat: "j1" });
  });

  it("never seats an unknown-class racer", () => {
    const slots = [slot("s1", "adult", "2026-08-07T19:00:00")];
    expect(autoAssignRaces({ slots, members: [m("x", null)], conflicts })).toEqual({});
  });

  it("returns nothing when there are no ready racers", () => {
    const slots = [slot("s1", "adult", "2026-08-07T19:00:00")];
    expect(autoAssignRaces({ slots, members: [], conflicts })).toEqual({});
  });

  it("returns nothing when there are no open slots", () => {
    expect(autoAssignRaces({ slots: [], members: [m("a")], conflicts })).toEqual({});
  });
});

describe("autoAssignRaces — class safety", () => {
  it("never puts a junior in an adult seat or vice versa", () => {
    const slots = [
      slot("adultSeat", "adult", "2026-08-07T19:00:00"),
      slot("juniorSeat", "junior", "2026-08-07T21:00:00", "Blue"),
    ];
    const out = autoAssignRaces({ slots, members: [m("grown"), m("kid", "junior")], conflicts });
    expect(out).toEqual({ adultSeat: "grown", juniorSeat: "kid" });
  });
});

describe("autoAssignRaces — spacing", () => {
  it("never produces an arrangement the spacing rule would reject", () => {
    // Two seats 10 minutes apart, one racer: only one can be filled.
    const slots = [
      slot("s1", "adult", "2026-08-07T19:00:00"),
      slot("s2", "adult", "2026-08-07T19:10:00"),
    ];
    const out = autoAssignRaces({ slots, members: [m("solo")], conflicts });
    expect(Object.keys(out)).toEqual(["s1"]);
  });

  it("spreads two racers across two close seats rather than stacking one", () => {
    const slots = [
      slot("s1", "adult", "2026-08-07T19:00:00"),
      slot("s2", "adult", "2026-08-07T19:10:00"),
    ];
    const out = autoAssignRaces({ slots, members: [m("a"), m("b")], conflicts });
    expect(out).toEqual({ s1: "a", s2: "b" });
  });

  it("with no conflict rule, one racer can hold every compatible seat", () => {
    const slots = [
      slot("s1", "adult", "2026-08-07T19:00:00"),
      slot("s2", "adult", "2026-08-07T19:10:00"),
    ];
    const out = autoAssignRaces({ slots, members: [m("solo")], conflicts: never });
    expect(out).toEqual({ s1: "solo", s2: "solo" });
  });
});
