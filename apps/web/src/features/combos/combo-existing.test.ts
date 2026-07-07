import { beforeEach, describe, expect, it, vi } from "vitest";

const listVipComboReservations = vi.fn();
vi.mock("@/lib/bowling-db", () => ({
  listVipComboReservations: (...args: unknown[]) => listVipComboReservations(...args),
}));

import { listComboGroupsForDate } from "./combo-existing.server";

type Row = Record<string, unknown>;

let nextId = 1;
function raceLeg(over: Row = {}): Row {
  return {
    id: nextId++,
    productKind: "race",
    comboSpecialId: "race-bowl",
    status: "confirmed",
    squareDepositOrderId: "DEP1",
    squareDayofOrderId: "DAYOF-RACE",
    bookingMetadata: {
      heats: [
        {
          heatId: "2026-07-10T16:00:00",
          track: "Red",
          tier: "starter",
          category: "adult",
          assignedTo: "m1",
          bmiPersonId: "17750277123456789",
        },
        {
          heatId: "2026-07-10T18:36:00",
          track: "Red",
          tier: "intermediate",
          category: "adult",
          assignedTo: "m1",
          bmiPersonId: "17750277123456789",
        },
        {
          heatId: "2026-07-10T16:00:00",
          track: "Red",
          tier: "starter",
          category: "adult",
          assignedTo: "m2",
          bmiPersonId: "17750277123456700",
        },
      ],
    },
    lines: [],
    ...over,
  };
}

function bowlingLeg(over: Row = {}): Row {
  return {
    id: nextId++,
    productKind: "open",
    comboSpecialId: "race-bowl",
    status: "confirmed",
    squareDepositOrderId: "DEP1",
    squareDayofOrderId: "DAYOF-BOWL",
    eventAt: "2026-07-10T16:45:00",
    playerCount: 2,
    lines: [],
    ...over,
  };
}

const call = () => listComboGroupsForDate({ dateYmd: "2026-07-10", comboSpecialId: "race-bowl" });

beforeEach(() => {
  listVipComboReservations.mockReset();
  nextId = 1;
});

describe("listComboGroupsForDate", () => {
  it("groups both legs by deposit order and reads the Starter anchor + bowling start", async () => {
    listVipComboReservations.mockResolvedValue([raceLeg(), bowlingLeg()]);
    const groups = await call();
    expect(groups).toEqual([
      {
        anchorHeatIso: "2026-07-10T16:00:00",
        startHour: 16,
        track: "Red",
        bowlingStartIso: "2026-07-10T16:45:00",
        partySize: 2, // distinct assignedTo, not heat count
      },
    ]);
    expect(listVipComboReservations).toHaveBeenCalledWith({
      startDate: "2026-07-10",
      endDate: "2026-07-10",
    });
  });

  it("anchor is the earliest STARTER heat, not the earliest heat overall", async () => {
    const leg = raceLeg();
    (leg.bookingMetadata as { heats: Row[] }).heats.unshift({
      heatId: "2026-07-10T15:48:00",
      track: "Blue",
      tier: "intermediate",
      assignedTo: "m1",
    });
    listVipComboReservations.mockResolvedValue([leg]);
    const [g] = await call();
    expect(g.anchorHeatIso).toBe("2026-07-10T16:00:00");
    expect(g.track).toBe("Red");
  });

  it("filters cancelled legs, other combo ids, and the excluded deposit order", async () => {
    listVipComboReservations.mockResolvedValue([
      raceLeg({ status: "cancelled" }),
      raceLeg({ comboSpecialId: "other-combo", squareDepositOrderId: "DEP2" }),
      raceLeg({ squareDepositOrderId: "DEP3" }),
    ]);
    const groups = await listComboGroupsForDate({
      dateYmd: "2026-07-10",
      comboSpecialId: "race-bowl",
      excludeDepositOrderId: "DEP3",
    });
    expect(groups).toEqual([]);
  });

  it("separates two groups on different deposit orders, sorted by anchor time", async () => {
    const late = raceLeg({ squareDepositOrderId: "DEP2" });
    (late.bookingMetadata as { heats: Row[] }).heats.forEach((h) => {
      h.heatId = (h.heatId as string).replace("T16:", "T20:").replace("T18:36", "T22:36");
    });
    listVipComboReservations.mockResolvedValue([late, raceLeg(), bowlingLeg()]);
    const groups = await call();
    expect(groups.map((g) => g.startHour)).toEqual([16, 20]);
  });

  it("skips a group with no recorded race heats; bowling-only rows never anchor", async () => {
    listVipComboReservations.mockResolvedValue([bowlingLeg()]);
    expect(await call()).toEqual([]);
  });

  it("falls back to playerCount when heats carry no assignedTo", async () => {
    const leg = raceLeg();
    (leg.bookingMetadata as { heats: Row[] }).heats.forEach((h) => delete h.assignedTo);
    listVipComboReservations.mockResolvedValue([leg, bowlingLeg()]);
    const [g] = await call();
    expect(g.partySize).toBe(2);
  });
});
