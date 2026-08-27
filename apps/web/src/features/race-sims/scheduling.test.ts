import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { BmiProposal } from "~/features/booking/data/bmi";
import type { RaceSimSession, SessionItem } from "~/features/booking/state/types";
import { newItem } from "~/features/booking/state/types";
import {
  RACE_SIM_TRACK_FALLBACK,
  cartKartSimConflictMessage,
  cartTimedBookings,
  findCartKartSimConflict,
  findRaceSimCrossBookingConflict,
  findRaceSimSelfConflict,
  isRaceSimTrackLabel,
  ownPickAtSameStart,
  raceSimBookingConflictMessage,
  raceSimCartPersonHeats,
  raceSimConflictTrack,
  raceSimSlotConflicts,
  wallClockMs,
} from "./scheduling";

const proposal = { blocks: [], productLineId: null } as unknown as BmiProposal;
const sess = (slot: string, trackKey: "a" | "b" | "c" = "a"): RaceSimSession => ({
  trackKey,
  slot,
  slotProposal: proposal,
  bmiLineId: null,
  heldQty: null,
});
const T = (hhmm: string) => `2026-08-27T${hhmm}:00`;
const ms = (hhmm: string) => wallClockMs(T(hhmm));

const race = (heats: { heatId: string; track: string }[]): SessionItem => ({
  ...(newItem("race") as Extract<SessionItem, { kind: "race" }>),
  id: "race1",
  heats: heats.map((h) => ({
    heatId: h.heatId,
    track: h.track,
    bmiLineId: null,
    racerId: "p1",
  })) as never,
});
const sim = (sessions: RaceSimSession[], id = "sim1"): SessionItem => ({
  ...(newItem("racesim") as Extract<SessionItem, { kind: "racesim" }>),
  id,
  productSlug: "sim-single",
  racerCount: 2,
  sessions,
});

describe("sim track labels", () => {
  it("each sim track carries its own display-name label; unknown → fallback", () => {
    expect(raceSimConflictTrack("a")).toBe("Track A");
    expect(raceSimConflictTrack("c")).toBe("Track C");
    expect(raceSimConflictTrack(null)).toBe(RACE_SIM_TRACK_FALLBACK);
    expect(isRaceSimTrackLabel("Track B")).toBe(true);
    expect(isRaceSimTrackLabel(RACE_SIM_TRACK_FALLBACK)).toBe(true);
    expect(isRaceSimTrackLabel("Red")).toBe(false);
    expect(isRaceSimTrackLabel(null)).toBe(false);
  });

  it("bowling-db emits the persisted per-session track label, not one flat literal", () => {
    // raceHeatsForPersonsOnDate's sim rows must surface the SAME label the
    // metadata writer persisted (getRaceSimTrack(...).name) so the grid's
    // isRaceSimTrackLabel check recognizes them as sims.
    const sql = readFileSync(resolve(__dirname, "../../../lib/bowling-db.ts"), "utf8");
    expect(sql).toContain("s.e->>'track' AS track");
    expect(sql).not.toContain("'Race Sim' AS track");
  });
});

describe("sim-vs-sim: same start on any track collides, back-to-back is allowed", () => {
  it("10:00 on Track A blocks 10:00 on B and C; 10:15 is open", () => {
    const picked = [sess(T("10:00"), "a")];
    expect(ownPickAtSameStart(picked, T("10:00"), "b")?.trackKey).toBe("a");
    expect(ownPickAtSameStart(picked, T("10:00"), "c")?.trackKey).toBe("a");
    expect(ownPickAtSameStart(picked, T("10:15"), "b")).toBeNull();
    // On the SAME track the pick is the card itself, not a block
    expect(ownPickAtSameStart(picked, T("10:00"), "a")).toBeNull();
  });

  it("another sim item in the cart: same start conflicts, adjacent does not (no gap rule)", () => {
    const others = cartTimedBookings([sim([sess(T("10:00"), "a")], "other")], "me");
    expect(others).toEqual([{ startMs: ms("10:00"), track: "Track A" }]);
    expect(raceSimSlotConflicts(ms("10:00"), others)).toBe(true);
    expect(raceSimSlotConflicts(ms("10:15"), others)).toBe(false);
    expect(raceSimSlotConflicts(ms("09:45"), others)).toBe(false);
  });

  it("self-check finds two of the item's own sessions on one start", () => {
    expect(findRaceSimSelfConflict([sess(T("10:00"), "a"), sess(T("10:15"), "b")])).toBeNull();
    const hit = findRaceSimSelfConflict([sess(T("10:00"), "a"), sess(T("10:00"), "b")]);
    expect(hit?.a.trackKey).toBe("a");
    expect(hit?.b.trackKey).toBe("b");
  });
});

describe("sim-vs-kart: racing's 30-minute cross-activity spacing", () => {
  it("a kart heat within 30 minutes blocks the sim card; 30+ is fine", () => {
    const others = cartTimedBookings([race([{ heatId: T("10:00"), track: "Red" }])], "me");
    expect(raceSimSlotConflicts(ms("10:15"), others)).toBe(true);
    expect(raceSimSlotConflicts(ms("10:29"), others)).toBe(true);
    expect(raceSimSlotConflicts(ms("10:30"), others)).toBe(false);
    expect(raceSimSlotConflicts(ms("09:30"), others)).toBe(false);
  });

  it("attractions/bowling (no track) use the same 30-minute rule", () => {
    const others = [{ startMs: ms("10:00"), track: null }];
    expect(raceSimSlotConflicts(ms("10:20"), others)).toBe(true);
    expect(raceSimSlotConflicts(ms("10:30"), others)).toBe(false);
  });

  it("cart-internal kart↔sim guard checks EVERY session and reports the pair", () => {
    const items = [
      race([{ heatId: T("11:00"), track: "Red" }]),
      sim([sess(T("15:00"), "a"), sess(T("11:15"), "b")]),
    ];
    const hit = findCartKartSimConflict(items);
    expect(hit).toEqual({ simSlot: T("11:15"), heatId: T("11:00"), track: "Red" });
    expect(cartKartSimConflictMessage(hit!)).toContain("30 minutes");
    expect(
      findCartKartSimConflict([
        race([{ heatId: T("11:00"), track: "Red" }]),
        sim([sess(T("11:30"), "a")]),
      ]),
    ).toBeNull();
    expect(findCartKartSimConflict([sim([sess(T("11:00"), "a")])])).toBeNull();
  });
});

describe("cross-reservation (same rider, other reservations today)", () => {
  const party = [
    { id: "p1", firstName: "Ana", lastName: "R", bmiPersonId: "12345678901234567" },
    { id: "p2", firstName: "Bo", lastName: "R", bmiPersonId: null },
  ] as never;

  it("emits one row per session × rider with a BMI id, labelled by track", () => {
    const item = sim([sess(T("10:00"), "a"), sess(T("10:15"), "b")]) as Extract<
      SessionItem,
      { kind: "racesim" }
    >;
    const rows = raceSimCartPersonHeats(item, party);
    expect(rows).toEqual([
      { heatId: T("10:00"), track: "Track A", bmiPersonId: "12345678901234567", racer: "Ana" },
      { heatId: T("10:15"), track: "Track B", bmiPersonId: "12345678901234567", racer: "Ana" },
    ]);
  });

  it("existing sim at the same start collides; adjacent existing sim does not; kart heat needs 30", () => {
    const cart = [{ heatId: T("10:00"), track: "Track A", bmiPersonId: "1", racer: "Ana" }];
    const sameSim = [{ heatId: T("10:00"), track: "Track C", bmiPersonId: "1", racer: null }];
    const nextSim = [{ heatId: T("10:15"), track: "Track C", bmiPersonId: "1", racer: null }];
    const kart = [{ heatId: T("10:20"), track: "Blue", bmiPersonId: "1", racer: null }];
    const otherRider = [{ heatId: T("10:00"), track: "Track C", bmiPersonId: "2", racer: null }];
    expect(findRaceSimCrossBookingConflict(cart, sameSim)?.existing.track).toBe("Track C");
    expect(findRaceSimCrossBookingConflict(cart, nextSim)).toBeNull();
    expect(findRaceSimCrossBookingConflict(cart, kart)?.existing.track).toBe("Blue");
    expect(findRaceSimCrossBookingConflict(cart, otherRider)).toBeNull();
  });

  it("rejection copy names a sim session vs a race", () => {
    const base = { cart: { heatId: T("10:00"), racer: "Ana" } };
    expect(
      raceSimBookingConflictMessage({
        ...base,
        existing: { heatId: T("10:00"), track: "Track B" },
      }),
    ).toContain("already has a sim session");
    expect(
      raceSimBookingConflictMessage({ ...base, existing: { heatId: T("10:20"), track: "Red" } }),
    ).toContain("already has a race booked");
  });
});
