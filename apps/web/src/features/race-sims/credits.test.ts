import { describe, expect, it } from "vitest";
import {
  computeRaceSimCoverage,
  coveredSeatsFor,
  isSimCreditName,
  raceSimRedemptions,
  simCreditBalance,
} from "./credits";
import { RACE_SIM_DEPOSIT_KIND } from "./products";
import type { BookingSession, RaceSimItem } from "~/features/booking/state/types";

const SIM_KIND = RACE_SIM_DEPOSIT_KIND.anytime!;

function member(
  id: string,
  opts: { personId?: string | null; credits?: number; optIn?: boolean } = {},
) {
  return {
    id,
    firstName: id,
    lastName: "Test",
    bmiPersonId: opts.personId === undefined ? `p-${id}` : opts.personId,
    redeemCredits: opts.optIn ?? true,
    creditBalances:
      opts.credits && opts.credits > 0
        ? [{ kind: "Credit - Race Simulator", balance: opts.credits }]
        : [],
  } as unknown as BookingSession["party"][number];
}

function simItem(over: Partial<RaceSimItem> = {}): RaceSimItem {
  return {
    id: "sim-1",
    kind: "racesim",
    date: "2026-09-16",
    productKind: "single",
    productSlug: "sim-single",
    trackKey: "a",
    racerCount: 1,
    assignedTo: [],
    sessions: [],
    ...over,
  } as RaceSimItem;
}

function sess(slot: string) {
  return { trackKey: "a", slot, slotProposal: {}, bmiLineId: null, heldQty: null };
}

function session(items: RaceSimItem[], party: BookingSession["party"]): BookingSession {
  return { items, party, bmiBillId: null } as unknown as BookingSession;
}

describe("sim credit identification", () => {
  it("claims the sim deposit row and nothing else", () => {
    expect(isSimCreditName("Credit - Race Simulator")).toBe(true);
    expect(isSimCreditName("credit - race sim")).toBe(true);
    // Every karting kind must stay out — this is the ledger-separation rule.
    for (const n of [
      "Credit - Race Anytime",
      "Credit - Race Weekday",
      "Credit - Race Comp",
      "Credit - Race Membership",
      "Credit - Nexus Gel Blaster",
      "Employee Pass",
    ]) {
      expect(isSimCreditName(n), n).toBe(false);
    }
    expect(isSimCreditName(null)).toBe(false);
  });

  it("sums only sim rows, ignoring negatives and other kinds", () => {
    expect(
      simCreditBalance([
        { kind: "Credit - Race Simulator", balance: 3 },
        { kind: "Credit - Race Anytime", balance: 5 },
        { kind: "Credit - Race Simulator", balance: -2 },
      ]),
    ).toBe(3);
    expect(simCreditBalance(undefined)).toBe(0);
  });
});

describe("sim credit coverage", () => {
  it("covers one seat per credit, per rider, across sessions", () => {
    const party = [member("a", { credits: 2 })];
    const item = simItem({
      racerCount: 1,
      assignedTo: ["a"],
      sessions: [
        sess("2026-09-16T10:00:00"),
        sess("2026-09-16T11:00:00"),
        sess("2026-09-16T12:00:00"),
      ],
    });
    const coverage = computeRaceSimCoverage(session([item], party));
    // 2 credits → the first two sessions are covered, the third is cash.
    expect(coverage.map((c) => c.slot)).toEqual(["2026-09-16T10:00:00", "2026-09-16T11:00:00"]);
    expect(coverage.every((c) => c.covered === 1)).toBe(true);
    expect(coveredSeatsFor(coverage, "sim-1", "2026-09-16T12:00:00")).toBe(0);
  });

  it("covers only the riders who HOLD credits — the rest stay cash", () => {
    // The party-of-three split that forces the charge line to break in two.
    const party = [
      member("a", { credits: 1 }),
      member("b", { credits: 0 }),
      member("c", { credits: 0 }),
    ];
    const item = simItem({
      racerCount: 3,
      assignedTo: ["a", "b", "c"],
      sessions: [sess("2026-09-16T10:00:00")],
    });
    const coverage = computeRaceSimCoverage(session([item], party));
    expect(coverage).toHaveLength(1);
    expect(coverage[0]!.covered).toBe(1);
  });

  it("never spends a credit for someone who opted OUT", () => {
    const party = [member("a", { credits: 5, optIn: false })];
    const item = simItem({
      racerCount: 1,
      assignedTo: ["a"],
      sessions: [sess("2026-09-16T10:00:00")],
    });
    expect(computeRaceSimCoverage(session([item], party))).toEqual([]);
  });

  it("never spends a credit for someone Pandora does not know", () => {
    // No bmiPersonId = no ledger to draw from. Covering the seat would charge
    // $0 and deduct nothing — a free race.
    const party = [member("a", { personId: null, credits: 5 })];
    const item = simItem({
      racerCount: 1,
      assignedTo: ["a"],
      sessions: [sess("2026-09-16T10:00:00")],
    });
    expect(computeRaceSimCoverage(session([item], party))).toEqual([]);
  });

  it("buying a PACK never spends credits", () => {
    const party = [member("a", { credits: 5 })];
    const pack = simItem({
      id: "pack-1",
      productKind: "pack",
      productSlug: "sim-3-pack",
      sessions: [],
    });
    expect(computeRaceSimCoverage(session([pack], party))).toEqual([]);
  });

  it("shares one balance ACROSS items — 2 credits cover 2 seats in total", () => {
    // The bug a per-item walk would introduce: a member with 2 credits and a
    // session on each of two items covering 2 seats on BOTH.
    const party = [member("a", { credits: 2 })];
    const one = simItem({
      id: "sim-1",
      racerCount: 1,
      assignedTo: ["a"],
      sessions: [sess("2026-09-16T10:00:00"), sess("2026-09-16T11:00:00")],
    });
    const two = simItem({
      id: "sim-2",
      racerCount: 1,
      assignedTo: ["a"],
      sessions: [sess("2026-09-16T13:00:00")],
    });
    const coverage = computeRaceSimCoverage(session([one, two], party));
    expect(coverage.reduce((n, c) => n + c.covered, 0)).toBe(2);
    expect(coveredSeatsFor(coverage, "sim-2", "2026-09-16T13:00:00")).toBe(0);
  });

  it("emits a stable, per-seat redemption ref on the SIM kind", () => {
    const party = [member("a", { credits: 1 })];
    const item = simItem({
      racerCount: 1,
      assignedTo: ["a"],
      sessions: [sess("2026-09-16T10:00:00")],
    });
    const reds = raceSimRedemptions(session([item], party));
    expect(reds).toHaveLength(1);
    expect(reds[0]!.depositKindId).toBe(SIM_KIND);
    expect(reds[0]!.personId).toBe("p-a");
    // ref must be stable per (session, person) — it is half the idempotency
    // key that stops a retried reserve deducting the same credit twice.
    expect(reds[0]!.ref).toBe("sim:2026-09-16T10:00:00:p-a");
  });
});
