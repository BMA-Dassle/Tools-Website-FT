import { describe, expect, it } from "vitest";
import {
  isWaiverEvent,
  getWaiverStatus,
  getWaiverBarColor,
  getStateBadgePalette,
  BADGE_PALETTES,
  isDepositRequested,
  isSendContract,
  isPendingSignedContract,
  isContractStage,
  isOnlineReservation,
  applyViewTypeFilter,
  applyStateFilter,
  dayStats,
  weekRowFilter,
  isServiceChargeProduct,
  isInternalPayMethod,
} from "./logic";
import type { Reservation } from "./types";

const THRESHOLDS = { red: 60, yellow: 90 };

function res(overrides: Partial<Reservation>): Reservation {
  return {
    id: "63000000003675359",
    number: "W48833",
    kind: "Group Event",
    name: "Test Event",
    personName: "Pat Smith",
    persons: 10,
    when: "2026-07-12T17:00:00",
    state: "Confirmation",
    responsible: "Lori Lehman",
    balance: 0,
    _isDayPlannerBlock: false,
    ...overrides,
  };
}

describe("waiver detection (portal parity)", () => {
  it("detects waiver events by state substring", () => {
    expect(isWaiverEvent(res({ state: "Confirmation + Waiver", allResourceNames: [] }))).toBe(true);
  });

  it("detects waiver events by resource keywords", () => {
    for (const name of ["HP Arena", "Blue Track", "LaserTag", "Gel Blaster Zone"]) {
      expect(isWaiverEvent(res({ allResourceNames: [name] }))).toBe(true);
    }
  });

  it("falls back to resourceName when allResourceNames is empty", () => {
    expect(isWaiverEvent(res({ allResourceNames: [], resourceName: "Mini Track" }))).toBe(true);
  });

  it("does not flag bowling lanes", () => {
    expect(isWaiverEvent(res({ allResourceNames: ["Lane 5", "Lane 6"] }))).toBe(false);
  });

  it("threshold edges: <60 red, <=90 yellow, >90 green", () => {
    const arena = (registered: number, persons: number) =>
      getWaiverStatus(
        res({ allResourceNames: ["HP Arena"], registeredPersons: registered, persons }),
        THRESHOLDS,
      );
    expect(arena(5, 10)?.color).toBe("red"); // 50%
    expect(arena(6, 10)?.color).toBe("yellow"); // 60% — not < red
    expect(arena(9, 10)?.color).toBe("yellow"); // 90% — <= yellow
    expect(arena(91, 100)?.color).toBe("green"); // 91%
  });

  it("returns null without registeredPersons or persons", () => {
    expect(getWaiverStatus(res({ allResourceNames: ["HP Arena"] }), THRESHOLDS)).toBeNull();
    expect(
      getWaiverStatus(
        res({ allResourceNames: ["HP Arena"], registeredPersons: 3, persons: 0 }),
        THRESHOLDS,
      ),
    ).toBeNull();
  });

  it("bar color follows waiver status", () => {
    expect(
      getWaiverBarColor(
        res({ allResourceNames: ["HP Arena"], registeredPersons: 1, persons: 10 }),
        THRESHOLDS,
      ),
    ).toBe("#ef4444");
    expect(getWaiverBarColor(res({ allResourceNames: ["Lane 1"] }), THRESHOLDS)).toBeNull();
  });
});

describe("state badge palette (portal substring order)", () => {
  const cases: Array<[string, keyof typeof BADGE_PALETTES]> = [
    ["Confirmation", "green"],
    ["Confirmed + Waiver", "green"],
    ["Deposit Requested", "orange"],
    ["Pending Signed Contract", "purple"],
    ["Send Contract", "indigo"],
    ["Cancelled", "red"],
    ["Full", "yellow"],
    ["Booked", "blue"],
    ["New Lead", "amber"],
    ["Contacted", "sky"],
    ["Some Unknown State", "muted"],
  ];
  for (const [state, palette] of cases) {
    it(`${state} → ${palette}`, () => {
      expect(getStateBadgePalette(state)).toEqual(BADGE_PALETTES[palette]);
    });
  }
});

describe("state predicates", () => {
  it("isSendContract excludes pending", () => {
    expect(isSendContract("Send Contract")).toBe(true);
    expect(isSendContract("Pending Send Contract")).toBe(false);
  });

  it("isPendingSignedContract / isContractStage", () => {
    expect(isPendingSignedContract("Pending Signed Contract")).toBe(true);
    expect(isContractStage("Send Contract")).toBe(true);
    expect(isContractStage("Pending Signed Contract")).toBe(true);
    expect(isContractStage("Confirmation")).toBe(false);
  });

  it("isDepositRequested needs both words", () => {
    expect(isDepositRequested("Deposit Requested")).toBe(true);
    expect(isDepositRequested("Deposit Paid")).toBe(false);
  });

  it("isOnlineReservation keys on kind", () => {
    expect(isOnlineReservation(res({ kind: "Online" }))).toBe(true);
    expect(isOnlineReservation(res({ kind: "Group Event" }))).toBe(false);
  });
});

describe("filters + stats", () => {
  const list = [
    res({ id: "1", state: "Confirmation", persons: 10 }),
    res({ id: "2", state: "Deposit Requested", persons: 20 }),
    res({ id: "3", state: "Cancelled", persons: 5 }),
    res({ id: "4", kind: "Online", state: "Confirmed", persons: 2 }),
    res({ id: "5", state: "Send Contract", persons: 8 }),
    res({ id: "6", state: "Pending Signed Contract", persons: 12 }),
    res({ id: "7", state: "Booked", persons: 4 }),
  ];

  it("view type split", () => {
    expect(applyViewTypeFilter(list, "group").map((r) => r.id)).toEqual([
      "1",
      "2",
      "3",
      "5",
      "6",
      "7",
    ]);
    expect(applyViewTypeFilter(list, "online").map((r) => r.id)).toEqual(["4"]);
  });

  it("state filters", () => {
    const group = applyViewTypeFilter(list, "group");
    expect(applyStateFilter(group, "all")).toHaveLength(6);
    expect(applyStateFilter(group, "confirmed").map((r) => r.id)).toEqual(["1"]);
    expect(applyStateFilter(group, "cancelled").map((r) => r.id)).toEqual(["3"]);
    expect(applyStateFilter(group, "deposit_requested").map((r) => r.id)).toEqual(["2"]);
    expect(applyStateFilter(group, "send_contract").map((r) => r.id)).toEqual(["5"]);
    expect(applyStateFilter(group, "pending_signed").map((r) => r.id)).toEqual(["6"]);
  });

  it("dayStats", () => {
    const stats = dayStats(applyViewTypeFilter(list, "group"));
    expect(stats.total).toBe(6);
    expect(stats.totalPersons).toBe(10 + 20 + 5 + 8 + 12 + 4);
    expect(stats.confirmed).toBe(1);
  });

  it("weekRowFilter keeps confirmed/deposit/contract group functions only", () => {
    expect(list.filter(weekRowFilter).map((r) => r.id)).toEqual(["1", "2", "5", "6"]);
  });
});

describe("detail helpers", () => {
  it("service charge / gratuity split", () => {
    expect(isServiceChargeProduct("20% Service Charge")).toBe(true);
    expect(isServiceChargeProduct("Gratuity")).toBe(true);
    expect(isServiceChargeProduct("Pizza Party Pack")).toBe(false);
  });

  it("internal pay methods hidden", () => {
    expect(isInternalPayMethod("Method -1")).toBe(true);
    expect(isInternalPayMethod("Group Function")).toBe(true);
    expect(isInternalPayMethod("Paid on Square")).toBe(false);
  });
});
