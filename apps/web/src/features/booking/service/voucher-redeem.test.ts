import { describe, expect, it } from "vitest";
import {
  BMI_VOUCHER_RE,
  voucherCoveredHeatSet,
  voucherIsApplied,
  voucherCoveredAmount,
} from "./voucher-redeem";
import type { BookingSession, RaceHeatAssignment, RaceItem } from "../state/types";

// Real production voucher codes (owner-shared 2026-07-27) — the shared regex
// is also consumed by the kiosk classifier and the web promo input.
describe("BMI_VOUCHER_RE (shared)", () => {
  it("matches real production codes", () => {
    expect(BMI_VOUCHER_RE.test("K5B7C3S7Q4Z9Q9Z3M9A9T7Z2")).toBe(true);
    expect(BMI_VOUCHER_RE.test("X7A3M4D3G6Q5S4R6D5M7U7K8")).toBe(true);
  });
  it("rejects 0/1 digits and wrong lengths", () => {
    expect(BMI_VOUCHER_RE.test("K1B7C3S7Q4Z9Q9Z3M9A9T7Z2")).toBe(false);
    expect(BMI_VOUCHER_RE.test("K5B7C3S7Q4Z9")).toBe(false);
  });
});

const APPLIED = {
  code: "K5B7C3S7Q4Z9Q9Z3M9A9T7Z2",
  name: "Race Comp",
  billId: "63000000006397110",
  voucherOrderItemId: "63000000006397113",
};

function heat(heatId: string, productId: string, assignedTo = "m1"): RaceHeatAssignment {
  return { heatId, productId, track: "Red", assignedTo, category: "adult" } as RaceHeatAssignment;
}

function raceSession(heats: RaceHeatAssignment[], voucher: unknown = APPLIED): BookingSession {
  const item = {
    id: "item1",
    kind: "race",
    heats,
    // Starter Race Red (weekday) — real catalog product.
    productIdAdult: "24960859",
    productIdJunior: null,
    packageIdAdult: null,
    packageIdJunior: null,
    addons: [],
    povQuantity: 0,
  } as unknown as RaceItem;
  return {
    items: [item],
    party: [],
    appliedVoucher: voucher,
  } as unknown as BookingSession;
}

describe("voucherIsApplied", () => {
  it("true only for a real applied voucher", () => {
    expect(voucherIsApplied(APPLIED)).toBe(true);
    expect(voucherIsApplied({ code: "X", pending: true })).toBe(false);
    expect(voucherIsApplied({ code: "X", error: "unknown" })).toBe(false);
    expect(voucherIsApplied(null)).toBe(false);
    expect(voucherIsApplied(undefined)).toBe(false);
  });
});

describe("voucherCoveredHeatSet", () => {
  it("covers exactly ONE heat for an applied voucher", () => {
    const h1 = heat("2026-07-29T18:00:00", "24960859");
    const h2 = heat("2026-07-29T19:00:00", "24960859", "m2");
    const covered = voucherCoveredHeatSet(raceSession([h1, h2]), new Set());
    expect(covered.size).toBe(1);
    // Equal prices → earliest heat wins (deterministic).
    expect(covered.has(h1)).toBe(true);
  });

  it("covers nothing while the voucher is pending or errored", () => {
    const h1 = heat("2026-07-29T18:00:00", "24960859");
    expect(
      voucherCoveredHeatSet(raceSession([h1], { code: "X", pending: true }), new Set()).size,
    ).toBe(0);
    expect(
      voucherCoveredHeatSet(raceSession([h1], { code: "X", error: "unknown" }), new Set()).size,
    ).toBe(0);
    expect(voucherCoveredHeatSet(raceSession([h1], null), new Set()).size).toBe(0);
  });

  it("never doubles up on a heat credits/packs already cover", () => {
    const h1 = heat("2026-07-29T18:00:00", "24960859");
    const h2 = heat("2026-07-29T19:00:00", "24960859", "m2");
    const covered = voucherCoveredHeatSet(raceSession([h1, h2]), new Set([h1]));
    expect(covered.size).toBe(1);
    expect(covered.has(h2)).toBe(true);
  });

  it("returns empty when every heat is already covered", () => {
    const h1 = heat("2026-07-29T18:00:00", "24960859");
    expect(voucherCoveredHeatSet(raceSession([h1]), new Set([h1])).size).toBe(0);
  });

  it("skips heats with no heatId (unbooked)", () => {
    const h1 = { ...heat("", "24960859"), heatId: null } as unknown as RaceHeatAssignment;
    expect(voucherCoveredHeatSet(raceSession([h1]), new Set()).size).toBe(0);
  });
});

describe("voucherCoveredAmount", () => {
  it("differences the same line-builder the charge uses", () => {
    const h1 = heat("2026-07-29T18:00:00", "24960859");
    const covered = new Set([h1]);
    // sumLines stub: full = 41.98, with the covered heat excluded = 20.99.
    const amount = voucherCoveredAmount(covered, new Set(), (ex) => (ex.has(h1) ? 20.99 : 41.98));
    expect(amount).toBe(20.99);
  });
  it("is 0 for empty coverage", () => {
    expect(voucherCoveredAmount(new Set(), new Set(), () => 100)).toBe(0);
  });
});
