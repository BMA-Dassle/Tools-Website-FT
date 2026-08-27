import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { newItem, newPartyMember, type RaceSimItem, type SessionItem } from "~/features/booking";
import {
  RACE_SIM_CONFLICT_TRACK,
  cartKartSimConflictMessage,
  cartTimedBookings,
  findCartKartSimConflict,
  raceSimBookingConflictMessage,
  raceSimCartPersonHeats,
  raceSimSlotConflicts,
  wallClockMs,
} from "./scheduling";

const T = (hhmm: string) => wallClockMs(`2026-08-26T${hhmm}:00`);

describe("the sim conflict label is ONE string across TS and SQL", () => {
  it("raceHeatsForPersonsOnDate emits exactly RACE_SIM_CONFLICT_TRACK for sim rows", () => {
    // Grid (TS) and guard (SQL) must agree on the label or sim-vs-sim silently
    // degrades from same-track (skip a session) to cross-track (30 min).
    const sql = readFileSync(resolve(__dirname, "../../../lib/bowling-db.ts"), "utf8");
    expect(sql).toContain(`'${RACE_SIM_CONFLICT_TRACK}' AS track`);
  });
});

describe("findCartKartSimConflict — kart heat vs sim session in ONE cart", () => {
  const sim = (slot: string) =>
    ({ ...(newItem("racesim") as RaceSimItem), id: "s1", slot }) as SessionItem;
  const race = (heatId: string) =>
    ({
      ...newItem("race"),
      heats: [{ productId: "1", track: "Red", heatId, bmiLineId: null, assignedTo: "m1" }],
    }) as SessionItem;

  it("flags a kart heat within 30 min of the held sim, either order", () => {
    expect(
      findCartKartSimConflict([sim("2026-08-26T15:00:00"), race("2026-08-26T15:12:00")]),
    ).toEqual({ simSlot: "2026-08-26T15:00:00", heatId: "2026-08-26T15:12:00", track: "Red" });
    expect(
      findCartKartSimConflict([race("2026-08-26T14:45:00"), sim("2026-08-26T15:00:00")]),
    ).not.toBeNull();
  });

  it("clears at 30 minutes, and with no sim or no heat", () => {
    expect(
      findCartKartSimConflict([sim("2026-08-26T15:00:00"), race("2026-08-26T15:30:00")]),
    ).toBeNull();
    expect(findCartKartSimConflict([race("2026-08-26T15:00:00")])).toBeNull();
    expect(findCartKartSimConflict([sim("2026-08-26T15:00:00")])).toBeNull();
  });

  it("message names both times", () => {
    expect(
      cartKartSimConflictMessage({ simSlot: "2026-08-26T15:00:00", heatId: "2026-08-26T15:12:00" }),
    ).toContain("3:12 PM race is too close to your 3:00 PM sim session");
  });
});

describe("raceSimSlotConflicts — racing's spacing rule on a sim session", () => {
  it("sim vs karting heat is CROSS-track: 30-minute buffer", () => {
    const kart = [{ startMs: T("15:00"), track: "Red" }];
    expect(raceSimSlotConflicts(T("15:15"), kart)).toBe(true); // 15 min → too close
    expect(raceSimSlotConflicts(T("15:29"), kart)).toBe(true);
    expect(raceSimSlotConflicts(T("15:30"), kart)).toBe(false); // exactly 30 → clear
  });

  it("sim vs sim is SAME-track (shared rigs): skip at least one session", () => {
    const sim = [{ startMs: T("15:00"), track: RACE_SIM_CONFLICT_TRACK }];
    expect(raceSimSlotConflicts(T("15:15"), sim)).toBe(true); // back-to-back → too close
    expect(raceSimSlotConflicts(T("15:20"), sim)).toBe(false); // heatsConflict's 20-min fallback
  });

  it("attractions/bowling carry no track → the 30-minute cross rule", () => {
    const attr = [{ startMs: T("15:00"), track: null }];
    expect(raceSimSlotConflicts(T("15:20"), attr)).toBe(true);
    expect(raceSimSlotConflicts(T("15:30"), attr)).toBe(false);
  });
});

describe("cartTimedBookings — every other timed item, labelled for heatsConflict", () => {
  it("maps heats with their track, sims to the shared sim label, others to null", () => {
    const race = {
      ...newItem("race"),
      heats: [
        {
          productId: "1",
          track: "Blue",
          heatId: "2026-08-26T15:00:00",
          bmiLineId: null,
          assignedTo: "m1",
        },
      ],
    } as SessionItem;
    const sim = { ...(newItem("racesim") as RaceSimItem), id: "s1", slot: "2026-08-26T16:00:00" };
    const me = { ...(newItem("racesim") as RaceSimItem), id: "me", slot: "2026-08-26T17:00:00" };
    const out = cartTimedBookings([race, sim, me], "me");
    expect(out).toEqual([
      { startMs: T("15:00"), track: "Blue" },
      { startMs: T("16:00"), track: RACE_SIM_CONFLICT_TRACK },
    ]);
  });
});

describe("raceSimCartPersonHeats — per-rider rows for the cross-reservation guard", () => {
  it("emits one row per rider WITH a BMI id, racing's shape", () => {
    const a = newPartyMember({ firstName: "Ana", bmiPersonId: "70000000000000001" });
    const b = newPartyMember({ firstName: "Bo" }); // no BMI id → no identity to match
    const item = {
      ...(newItem("racesim") as RaceSimItem),
      slot: "2026-08-26T15:00:00",
      assignedTo: [a.id, b.id],
    };
    expect(raceSimCartPersonHeats(item, [a, b])).toEqual([
      {
        heatId: "2026-08-26T15:00:00",
        track: RACE_SIM_CONFLICT_TRACK,
        bmiPersonId: "70000000000000001",
        racer: "Ana",
      },
    ]);
  });

  it("falls back to the whole party when nothing is stamped, and to nothing without a slot", () => {
    const a = newPartyMember({ firstName: "Ana", bmiPersonId: "70000000000000001" });
    const stampless = { ...(newItem("racesim") as RaceSimItem), slot: "2026-08-26T15:00:00" };
    expect(raceSimCartPersonHeats(stampless, [a])).toHaveLength(1);
    expect(raceSimCartPersonHeats({ ...stampless, slot: null }, [a])).toEqual([]);
  });
});

describe("raceSimBookingConflictMessage", () => {
  it("names the rider and says session vs race by the existing booking's kind", () => {
    const msg = raceSimBookingConflictMessage({
      cart: { heatId: "2026-08-26T15:15:00", racer: "Ana" },
      existing: { heatId: "2026-08-26T15:00:00", track: "Red" },
    });
    expect(msg).toContain("Ana already has a race booked at 3:00 PM");
    expect(msg).toContain("3:15 PM session");
    const sim = raceSimBookingConflictMessage({
      cart: { heatId: null },
      existing: { heatId: "2026-08-26T15:00:00", track: RACE_SIM_CONFLICT_TRACK },
    });
    expect(sim).toContain("One of your riders already has a sim session booked");
  });
});
