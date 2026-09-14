import { describe, expect, it } from "vitest";

import {
  computeEmployeeFreeHeats,
  discountedUnitCents,
  employeeAttractionUnits,
  employeeMember,
} from "./employee-perks";
import type { RaceHeatAssignment } from "../state/types";

const stamp = { userId: 42, firstName: "Sam" };
const sam = { id: "sam", firstName: "Sam", employeePerks: stamp };
const jordan = { id: "jordan", firstName: "Jordan" };

function heat(over: Partial<RaceHeatAssignment> & { heatId: string }): RaceHeatAssignment {
  return { assignedTo: "sam", productId: "p1", category: "adult", ...over } as RaceHeatAssignment;
}

describe("employeeMember", () => {
  it("finds the stamped member and nobody else", () => {
    expect(employeeMember([jordan, sam])?.id).toBe("sam");
    expect(employeeMember([jordan])).toBeNull();
  });
});

describe("computeEmployeeFreeHeats", () => {
  const item = (heats: RaceHeatAssignment[], over: Record<string, unknown> = {}) => ({
    kind: "race",
    date: "2026-09-18",
    packageIdAdult: null,
    packageIdJunior: null,
    heats,
    ...over,
  });

  it("frees the employee's own heats in session order, up to the allowance", () => {
    const h1 = heat({ heatId: "a" });
    const h2 = heat({ heatId: "b" });
    const h3 = heat({ heatId: "c" });
    const res = computeEmployeeFreeHeats([item([h1, h2, h3])], [sam, jordan], new Set(), {
      usedThisWeek: 0,
    });
    expect([...res.heats]).toEqual([h1, h2]);
    expect(res.memberId).toBe("sam");
  });

  it("subtracts what was already used this pay week", () => {
    const h1 = heat({ heatId: "a" });
    const h2 = heat({ heatId: "b" });
    const res = computeEmployeeFreeHeats([item([h1, h2])], [sam], new Set(), { usedThisWeek: 1 });
    expect([...res.heats]).toEqual([h1]);
    const none = computeEmployeeFreeHeats([item([h1, h2])], [sam], new Set(), { usedThisWeek: 2 });
    expect(none.heats.size).toBe(0);
    expect(none.memberId).toBeNull();
  });

  it("never frees another racer's heat, a covered heat, or a package heat", () => {
    const own = heat({ heatId: "a" });
    const theirs = heat({ heatId: "b", assignedTo: "jordan" });
    const covered = heat({ heatId: "c" });
    const pkgHeat = heat({ heatId: "d", category: "junior" });
    const res = computeEmployeeFreeHeats(
      [item([theirs, covered, pkgHeat, own], { packageIdJunior: "rookie-jr" })],
      [sam, jordan],
      new Set([covered]),
      { usedThisWeek: 0 },
    );
    expect([...res.heats]).toEqual([own]);
  });

  it("does nothing without a stamped member or without an employee", () => {
    const h1 = heat({ heatId: "a" });
    expect(
      computeEmployeeFreeHeats([item([h1])], [jordan], new Set(), { usedThisWeek: 0 }).heats.size,
    ).toBe(0);
    expect(computeEmployeeFreeHeats([item([h1])], [sam], new Set(), null).heats.size).toBe(0);
  });

  it("ignores heats with no id and items with no date", () => {
    const pending = heat({ heatId: "" as unknown as string });
    expect(
      computeEmployeeFreeHeats([item([pending])], [sam], new Set(), { usedThisWeek: 0 }).heats.size,
    ).toBe(0);
    const h1 = heat({ heatId: "a" });
    expect(
      computeEmployeeFreeHeats([item([h1], { date: null })], [sam], new Set(), { usedThisWeek: 0 })
        .heats.size,
    ).toBe(0);
  });
});

describe("employeeAttractionUnits", () => {
  it("counts the employee's assigned units on the kiosk", () => {
    const res = employeeAttractionUnits(
      { slug: "gel-blaster", qty: 3, participants: ["sam", "jordan", "sam"] },
      [sam, jordan],
    );
    expect(res).toEqual({ units: 2, percentOff: 50 });
  });

  it("gives exactly one own unit when nobody is named (web)", () => {
    expect(
      employeeAttractionUnits({ slug: "laser-tag", qty: 3, assignedTo: [] }, [sam, jordan]),
    ).toEqual({
      units: 1,
      percentOff: 50,
    });
  });

  it("gives nothing for other attractions, other people, or no employee", () => {
    expect(
      employeeAttractionUnits({ slug: "duck-pin", qty: 2, assignedTo: ["sam"] }, [sam]).units,
    ).toBe(0);
    expect(
      employeeAttractionUnits({ slug: "gel-blaster", qty: 2, assignedTo: ["jordan"] }, [
        sam,
        jordan,
      ]).units,
    ).toBe(0);
    expect(
      employeeAttractionUnits({ slug: "gel-blaster", qty: 2, assignedTo: [] }, [jordan]).units,
    ).toBe(0);
  });

  it("caps at the line quantity", () => {
    expect(
      employeeAttractionUnits({ slug: "gel-blaster", qty: 1, participants: ["sam", "sam"] }, [sam])
        .units,
    ).toBe(1);
  });
});

describe("discountedUnitCents", () => {
  it("rounds to the cent", () => {
    expect(discountedUnitCents(1999, 50)).toBe(1000);
    expect(discountedUnitCents(1799, 50)).toBe(900);
    expect(discountedUnitCents(1000, 0)).toBe(1000);
  });
});
