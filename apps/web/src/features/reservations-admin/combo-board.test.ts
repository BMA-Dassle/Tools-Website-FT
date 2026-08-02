import { describe, expect, it } from "vitest";
import {
  buildComboGroups,
  buildComboScheduleIndex,
  mergeComboRows,
  stepProgress,
} from "./combo-board";
import { etWallMs } from "./format";
import type { ComboMeta, ComboScheduleStep, Reservation } from "./types";

/**
 * Fixtures pin the board behavior that shipped through 2026-07-03 (VIP live
 * progress + schedule-aware retirement). Race heat ISOs are NAIVE ET
 * wall-clock (no zone); bowling bookedAt is offset-aware — both shapes must
 * sort/compare in the same frame via etWallMs.
 */

let nextId = 1;
function res(partial: Partial<Reservation>): Reservation {
  return {
    id: nextId++,
    centerCode: "fort-myers",
    productKind: "open",
    depositCents: 0,
    totalCents: 0,
    refundCents: 0,
    rewardDiscountCents: 0,
    promoSavingsCents: 0,
    status: "confirmed",
    bookedAt: "2026-07-06T21:30:00.000Z", // 5:30 PM ET
    insertedAt: "2026-07-01T12:00:00.000Z",
    lines: [],
    ...partial,
  };
}

const META: Record<string, ComboMeta> = {
  "race-bowl": {
    name: "Ultimate VIP Experience",
    accentColor: "#d4af37",
    includes: ["Starter Race", "VIP Bowling", "Intermediate Race"],
    center: "fort-myers",
    bowlingDurationMinutes: 90,
  },
};

/** A split combo: race leg (FastTrax day-of order) + bowling leg (HeadPinz
 *  day-of order), sharing one deposit order. */
function splitCombo(overrides?: {
  raceStatus?: string;
  bowlStatus?: string;
  liveHeats?: Reservation["liveHeats"];
}) {
  const race = res({
    productKind: "race",
    comboSpecialId: "race-bowl",
    status: overrides?.raceStatus ?? "confirmed",
    squareDepositOrderId: "DEP1",
    squareDayofOrderId: "RACEORD",
    bmiBillId: "18014567890123456789", // > MAX_SAFE_INTEGER — must stay a string
    totalCents: 12345,
    bookedAt: "2026-07-06T20:00:00.000Z",
    guestName: "Priya Natarajan",
    bookingMetadata: {
      heats: [
        { heatId: "2026-07-06T17:00:00", track: "Red Track" },
        { heatId: "2026-07-06T19:24:00", track: "Blue Track" },
      ],
    },
    liveHeats: overrides?.liveHeats,
  });
  const bowl = res({
    productKind: "open",
    comboSpecialId: "race-bowl",
    status: overrides?.bowlStatus ?? "confirmed",
    squareDepositOrderId: "DEP1",
    squareDayofOrderId: "BOWLORD",
    totalCents: 12346,
    bookedAt: "2026-07-06T21:30:00.000Z", // 5:30 PM ET
    dayofOrderLane: "Lane 7",
    guestName: "Priya Natarajan",
    eventAt: "2026-07-06T17:30:00",
  });
  return { race, bowl };
}

describe("stepProgress", () => {
  const step = (p: Partial<ComboScheduleStep>): ComboScheduleStep => ({
    icon: "x",
    label: "Step",
    iso: "2026-07-06T17:00:00",
    loc: "FastTrax",
    durationMin: 30,
    ...p,
  });
  const at = (iso: string) => etWallMs(iso);

  it("completed legStatus is done regardless of clock", () => {
    expect(stepProgress(step({ legStatus: "completed" }), at("2026-07-06T10:00:00"))).toEqual({
      state: "done",
      minsLeft: 0,
      minsUntil: 0,
      overdue: false,
    });
  });

  it("arrived lane is active past its scheduled end (running over, not done)", () => {
    const p = stepProgress(step({ legStatus: "arrived" }), at("2026-07-06T17:45:00"));
    expect(p).toMatchObject({ state: "active", minsLeft: 0, overdue: true });
  });

  it("schedule-active bowling without an open lane is overdue (not checked in)", () => {
    const p = stepProgress(step({ legStatus: "confirmed" }), at("2026-07-06T17:10:00"));
    expect(p).toMatchObject({ state: "active", overdue: true });
    expect(p!.minsLeft).toBeCloseTo(20, 5);
  });

  it("race step (no legStatus) is plain active in-window, done after", () => {
    expect(stepProgress(step({}), at("2026-07-06T17:10:00"))).toMatchObject({
      state: "active",
      overdue: false,
    });
    expect(stepProgress(step({}), at("2026-07-06T17:31:00"))).toMatchObject({ state: "done" });
  });

  it("upcoming with minutes-until; null iso yields null", () => {
    const p = stepProgress(step({}), at("2026-07-06T16:00:00"));
    expect(p).toMatchObject({ state: "upcoming" });
    expect(p!.minsUntil).toBeCloseTo(60, 5);
    expect(stepProgress(step({ iso: null }), at("2026-07-06T16:00:00"))).toBeNull();
  });

  // ── Race live truth (raceState) beats the clock, mirroring bowling ────────

  it("finished raceState is done even before the scheduled end", () => {
    expect(stepProgress(step({ raceState: "finished" }), at("2026-07-06T17:05:00"))).toEqual({
      state: "done",
      minsLeft: 0,
      minsUntil: 0,
      overdue: false,
    });
  });

  it("on_track stays active past the scheduled end (running behind, not done)", () => {
    const p = stepProgress(step({ raceState: "on_track" }), at("2026-07-06T17:45:00"));
    expect(p).toMatchObject({ state: "active", minsLeft: 0, overdue: false });
  });

  it("called is active regardless of the clock", () => {
    const p = stepProgress(step({ raceState: "called" }), at("2026-07-06T17:40:00"));
    expect(p).toMatchObject({ state: "active", overdue: false });
  });

  it("not_called past the scheduled END is active + overdue — never done (the old clock lie)", () => {
    const p = stepProgress(step({ raceState: "not_called" }), at("2026-07-06T17:40:00"));
    expect(p).toMatchObject({ state: "active", overdue: true });
  });

  it("not_called between start and end is active without the amber flag (normal drift)", () => {
    const p = stepProgress(step({ raceState: "not_called" }), at("2026-07-06T17:10:00"));
    expect(p).toMatchObject({ state: "active", overdue: false });
  });

  it("not_called before the scheduled start is just upcoming", () => {
    const p = stepProgress(step({ raceState: "not_called" }), at("2026-07-06T16:00:00"));
    expect(p).toMatchObject({ state: "upcoming" });
  });
});

describe("buildComboGroups", () => {
  const NOW_DURING = etWallMs("2026-07-06T17:15:00");

  it("groups split-order legs on the shared deposit order and sums BOTH day-of orders", () => {
    const { race, bowl } = splitCombo();
    const groups = buildComboGroups([race, bowl], META, NOW_DURING);
    expect(groups).toHaveLength(1);
    const g = groups[0];
    expect(g.legs).toHaveLength(2);
    expect(g.anchor.id).toBe(bowl.id); // bowling leg anchors
    expect(g.totalCents).toBe(12345 + 12346); // sum of DISTINCT orders, never max
    expect(g.dayofOrders.map((o) => o.orderId).sort()).toEqual(["BOWLORD", "RACEORD"]);
  });

  it("pre-split combo (one shared day-of order) counts that order once", () => {
    const { race, bowl } = splitCombo();
    race.squareDayofOrderId = "SHARED";
    bowl.squareDayofOrderId = "SHARED";
    race.totalCents = 24680;
    bowl.totalCents = 24680;
    const g = buildComboGroups([race, bowl], META, NOW_DURING)[0];
    expect(g.dayofOrders).toHaveLength(1);
    expect(g.totalCents).toBe(24680); // shared order NOT double-counted
  });

  it("schedule uses booking_metadata heats (Starter first) with track tags; bowling from the combo registry", () => {
    const { race, bowl } = splitCombo();
    const g = buildComboGroups([race, bowl], META, NOW_DURING)[0];
    expect(g.schedule.map((s) => s.label)).toEqual([
      "Starter Race · Red",
      "VIP Bowling",
      "Intermediate Race · Blue",
    ]);
    const bowlStep = g.schedule[1];
    expect(bowlStep.durationMin).toBe(90);
    expect(bowlStep.legStatus).toBe("confirmed");
    expect(bowlStep.lane).toBe("Lane 7");
  });

  it("liveHeats (BMI truth) override metadata heats — labels, times, and real session length", () => {
    const { race, bowl } = splitCombo({
      liveHeats: [
        { start: "2026-07-06T17:00:00", stop: "2026-07-06T17:09:00", name: "Starter Race Red" },
        { start: "2026-07-06T19:24:00", stop: "2026-07-06T19:33:00", name: "Starter Race Blue" },
      ],
    });
    const g = buildComboGroups([race, bowl], META, NOW_DURING)[0];
    const races = g.schedule.filter((s) => s.label.includes("Race"));
    expect(races.map((s) => s.label)).toEqual(["Starter Race · Red", "Starter Race · Blue"]);
    expect(races[0].durationMin).toBeCloseTo(9, 5); // real 9-min session, not the 30-min rule
  });

  it("appends the resolved session heat number to live race labels (session identity)", () => {
    const { race, bowl } = splitCombo({
      liveHeats: [
        {
          start: "2026-07-06T17:00:00",
          stop: "2026-07-06T17:09:00",
          name: "Starter Race Red",
          heatNumber: 42,
        },
        // Unresolved heat (no same-day session match) keeps the plain label.
        { start: "2026-07-06T19:24:00", stop: "2026-07-06T19:33:00", name: "Starter Race Blue" },
      ],
    });
    const g = buildComboGroups([race, bowl], META, NOW_DURING)[0];
    const races = g.schedule.filter((s) => s.label.includes("Race"));
    expect(races.map((s) => s.label)).toEqual([
      "Starter Race · Red · Heat 42",
      "Starter Race · Blue",
    ]);
  });

  it("adds a pending Intermediate step when the registry expects one and only one heat is booked", () => {
    const { race, bowl } = splitCombo();
    race.bookingMetadata = { heats: [{ heatId: "2026-07-06T17:00:00", track: "Red Track" }] };
    const g = buildComboGroups([race, bowl], META, NOW_DURING)[0];
    const last = g.schedule[g.schedule.length - 1];
    expect(last).toMatchObject({ label: "Intermediate Race", pending: true, iso: null });
  });

  it("retirement is GROUP+SCHEDULE: terminal legs stay active until 30 min past the last step end", () => {
    const { race, bowl } = splitCombo({ raceStatus: "completed", bowlStatus: "completed" });
    // Last step = 7:24 PM race (30 min assumed) → ends 7:54, retire at 8:24.
    const before = buildComboGroups([race, bowl], META, etWallMs("2026-07-06T20:23:00"));
    expect(before[0].inactive).toBe(false);
    const after = buildComboGroups([race, bowl], META, etWallMs("2026-07-06T20:25:00"));
    expect(after[0].inactive).toBe(true);
  });

  it("an open lane (arrived) keeps the combo active even past the schedule", () => {
    const { race, bowl } = splitCombo({ raceStatus: "completed", bowlStatus: "arrived" });
    const g = buildComboGroups([race, bowl], META, etWallMs("2026-07-06T23:00:00"))[0];
    // allTerminal is false while the lane shows arrived, and laneOpen guards too.
    expect(g.inactive).toBe(false);
  });

  it("a heat the track hasn't run yet holds retirement open past the 30-min mark", () => {
    // Last step = 7:24 PM heat (9-min real session) → schedule says retire
    // ~8:03 PM. Track truth says it never ran — card stays active…
    const { race, bowl } = splitCombo({
      raceStatus: "completed",
      bowlStatus: "completed",
      liveHeats: [
        {
          start: "2026-07-06T17:00:00",
          stop: "2026-07-06T17:09:00",
          name: "Starter Race Red",
          raceState: "finished",
        },
        {
          start: "2026-07-06T19:24:00",
          stop: "2026-07-06T19:33:00",
          name: "Starter Race Blue",
          raceState: "not_called",
        },
      ],
    });
    const held = buildComboGroups([race, bowl], META, etWallMs("2026-07-06T20:30:00"))[0];
    expect(held.inactive).toBe(false);
    // …but the 6h hard cap still retires a card the data quirk left open.
    const capped = buildComboGroups([race, bowl], META, etWallMs("2026-07-07T01:35:00"))[0];
    expect(capped.inactive).toBe(true);
  });

  it("all heats finished retires on the normal 30-min schedule rule", () => {
    const { race, bowl } = splitCombo({
      raceStatus: "completed",
      bowlStatus: "completed",
      liveHeats: [
        {
          start: "2026-07-06T17:00:00",
          stop: "2026-07-06T17:09:00",
          name: "Starter Race Red",
          raceState: "finished",
        },
        {
          start: "2026-07-06T19:24:00",
          stop: "2026-07-06T19:33:00",
          name: "Starter Race Blue",
          raceState: "finished",
        },
      ],
    });
    const g = buildComboGroups([race, bowl], META, etWallMs("2026-07-06T20:05:00"))[0];
    expect(g.inactive).toBe(true); // 9-min session ended 7:33 + 30 min = 8:03
  });

  it("all-cancelled combos retire immediately", () => {
    const { race, bowl } = splitCombo({ raceStatus: "cancelled", bowlStatus: "cancelled" });
    const g = buildComboGroups([race, bowl], META, etWallMs("2026-07-06T10:00:00"))[0];
    expect(g.inactive).toBe(true);
  });

  it("never coerces the BMI bill id", () => {
    const { race, bowl } = splitCombo();
    const g = buildComboGroups([race, bowl], META, NOW_DURING)[0];
    const raceLeg = g.races[0];
    expect(raceLeg.bmiBillId).toBe("18014567890123456789");
  });

  // ── $0 comp (100% promo): NO deposit order exists ─────────────────────────
  // Live case 2026-08-02 (Henrry Gomez VIP V2 comp): the two legs carried only
  // their two DIFFERENT day-of order ids, split into two cards (bowling-only
  // "Starter TBD" + a race-only card), and the race card sorted to the top of
  // the page on its 4 AM booking timestamp.

  /** A comped combo: same guest + event date, no deposit order, different day-of orders. */
  function compCombo() {
    const race = res({
      productKind: "race",
      comboSpecialId: "race-bowl",
      squareDayofOrderId: "RACEORD-COMP",
      bmiBillId: "63000000007006612",
      totalCents: 0,
      promoSavingsCents: 69300,
      promoCode: "VIPCOMP-HG-0802",
      bookedAt: "2026-07-06T08:09:30.000Z", // 4:09 AM ET BOOKING timestamp, not the heat time
      eventAt: "2026-07-06T18:00:00",
      guestName: "Henrry Gomez",
      guestPhone: "7866097355",
      playerCount: 14, // heat-slot count, NOT people
      bookingMetadata: {
        heats: [
          { heatId: "2026-07-06T18:00:00", track: "Blue Track", tier: "starter", category: "junior" },
          { heatId: "2026-07-06T18:00:00", track: "Blue Track", tier: "starter", category: "junior" },
          { heatId: "2026-07-06T18:12:00", track: "Blue Track", tier: "starter", category: "adult" },
          { heatId: "2026-07-06T20:36:00", track: "Blue Track", tier: "intermediate", category: "junior" },
          { heatId: "2026-07-06T20:48:00", track: "Blue Track", tier: "intermediate", category: "adult" },
        ],
      },
    });
    const bowl = res({
      productKind: "open",
      comboSpecialId: "race-bowl",
      squareDayofOrderId: "BOWLORD-COMP",
      totalCents: 0,
      bookedAt: "2026-07-06T22:45:00.000Z", // 6:45 PM ET slot
      eventAt: "2026-07-06T18:45:00",
      guestName: "Henrry Gomez",
      guestPhone: "7866097355",
      playerCount: 7,
      dayofOrderLane: "9, 10",
    });
    return { race, bowl };
  }

  it("comp legs (no deposit order) group on combo+guest+event date into ONE card", () => {
    const { race, bowl } = compCombo();
    const groups = buildComboGroups([race, bowl], META, NOW_DURING);
    expect(groups).toHaveLength(1);
    const g = groups[0];
    expect(g.legs).toHaveLength(2);
    expect(g.anchor.id).toBe(bowl.id); // bowling leg anchors → 7p, not 14p
    expect(g.playerCount).toBe(7);
    expect(g.dayofOrders.map((o) => o.orderId).sort()).toEqual(["BOWLORD-COMP", "RACEORD-COMP"]);
  });

  it("comp card carries the pre-promo package value as grossCents", () => {
    const { race, bowl } = compCombo();
    const g = buildComboGroups([race, bowl], META, NOW_DURING)[0];
    expect(g.totalCents).toBe(0);
    expect(g.grossCents).toBe(69300);
  });

  it("a paid combo's grossCents equals its charged total (no stamped savings)", () => {
    const { race, bowl } = splitCombo();
    const g = buildComboGroups([race, bowl], META, NOW_DURING)[0];
    expect(g.grossCents).toBe(g.totalCents);
  });

  it("metadata fallback renders EVERY distinct session (jr/adult splits), labeled by tier+category", () => {
    const { race, bowl } = compCombo();
    const g = buildComboGroups([race, bowl], META, NOW_DURING)[0];
    expect(g.schedule.map((s) => s.label)).toEqual([
      "Junior Starter Race · Blue",
      "Starter Race · Blue",
      "VIP Bowling",
      "Junior Intermediate Race · Blue",
      "Intermediate Race · Blue",
    ]);
    // Intermediates ARE booked — no phantom pending step.
    expect(g.schedule.some((s) => s.pending)).toBe(false);
  });

  it("groups sort by first VISIT step, not the race leg's 4 AM booking timestamp", () => {
    const { race } = compCombo(); // race-only group (no bowling leg yet)
    const { race: paidRace, bowl: paidBowl } = splitCombo(); // heats at 1:00 PM ET
    const groups = buildComboGroups([race, paidRace, paidBowl], META, NOW_DURING);
    expect(groups).toHaveLength(2);
    // Paid combo's first heat is 1 PM; the comp's first heat is 6 PM — the
    // comp belongs at the BOTTOM even though it was booked at 4 AM.
    expect(groups[0].guestName).toBe("Priya Natarajan");
    expect(groups[1].guestName).toBe("Henrry Gomez");
  });
});

describe("buildComboScheduleIndex + mergeComboRows", () => {
  const NOW = etWallMs("2026-07-06T17:15:00");

  it("indexes every deposit + day-of order id a leg carries", () => {
    const { race, bowl } = splitCombo();
    const idx = buildComboScheduleIndex(buildComboGroups([race, bowl], META, NOW));
    expect(idx.get("DEP1")?.name).toBe("Ultimate VIP Experience");
    expect(idx.get("RACEORD")).toBeDefined();
    expect(idx.get("BOWLORD")).toBeDefined();
  });

  it("merges combo legs into one bowling-anchored row with combined total + per-order entries", () => {
    const { race, bowl } = splitCombo();
    const plain = res({ guestName: "Marcus Webb", eventAt: "2026-07-06T16:00:00" });
    const idx = buildComboScheduleIndex(buildComboGroups([race, bowl], META, NOW));
    const rows = mergeComboRows([plain, race, bowl], true, idx);
    expect(rows).toHaveLength(2);
    const comboRow = rows.find((r) => r.comboMerge);
    expect(comboRow?.id).toBe(bowl.id);
    expect(comboRow?.comboMerge).toMatchObject({
      totalCents: 12345 + 12346,
      legCount: 2,
      raceBillId: "18014567890123456789",
    });
    expect(comboRow?.comboMerge?.orders.map((o) => o.kind).sort()).toEqual(["Bowling", "Racing"]);
  });

  it("drops the merged row only when the GROUP is inactive and Active Only is on", () => {
    const { race, bowl } = splitCombo({ raceStatus: "completed", bowlStatus: "completed" });
    const groupsLate = buildComboGroups([race, bowl], META, etWallMs("2026-07-06T21:00:00"));
    const idxLate = buildComboScheduleIndex(groupsLate);
    expect(mergeComboRows([race, bowl], true, idxLate)).toHaveLength(0); // retired + hidden
    expect(mergeComboRows([race, bowl], false, idxLate)).toHaveLength(1); // Active Only off
    const groupsEarly = buildComboGroups([race, bowl], META, etWallMs("2026-07-06T18:00:00"));
    expect(mergeComboRows([race, bowl], true, buildComboScheduleIndex(groupsEarly))).toHaveLength(
      1,
    ); // schedule still ahead
  });

  it("sorts rows on eventAt (naive ET) falling back to bookedAt (zoned) in one frame", () => {
    const early = res({ guestName: "A", eventAt: "2026-07-06T13:00:00" }); // naive 1 PM ET
    const late = res({ guestName: "B", bookedAt: "2026-07-06T22:00:00.000Z" }); // 6 PM ET zoned
    const rows = mergeComboRows([late, early], true, new Map());
    expect(rows.map((r) => r.guestName)).toEqual(["A", "B"]);
  });
});
