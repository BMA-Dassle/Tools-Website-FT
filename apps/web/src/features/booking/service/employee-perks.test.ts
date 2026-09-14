import { describe, expect, it } from "vitest";

import {
  computeEmployeeFreeHeats,
  discountedUnitCents,
  employeeAttractionUnits,
  employeeMembers,
} from "./employee-perks";
import type { RaceHeatAssignment } from "../state/types";

const sam = { id: "sam", firstName: "Sam", employeePerks: { userId: 42, firstName: "Sam" } };
const alex = { id: "alex", firstName: "Alex", employeePerks: { userId: 77, firstName: "Alex" } };
const jordan = { id: "jordan", firstName: "Jordan" };

/** The session's employee list — what `sessionEmployees(session)` hands the walks. */
const samEmp = { memberId: "sam", usedThisWeek: 0 };
const alexEmp = { memberId: "alex", usedThisWeek: 1 };

function heat(over: Partial<RaceHeatAssignment> & { heatId: string }): RaceHeatAssignment {
  return { assignedTo: "sam", productId: "p1", category: "adult", ...over } as RaceHeatAssignment;
}

describe("employeeMembers", () => {
  it("finds every stamped member and nobody else", () => {
    expect(employeeMembers([jordan, sam]).map((m) => m.id)).toEqual(["sam"]);
    expect(employeeMembers([sam, jordan, alex]).map((m) => m.id)).toEqual(["sam", "alex"]);
    expect(employeeMembers([jordan])).toEqual([]);
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
    const res = computeEmployeeFreeHeats([item([h1, h2, h3])], [sam, jordan], new Set(), [samEmp]);
    expect([...res.heats]).toEqual([h1, h2]);
    expect(res.memberIds).toEqual(["sam"]);
  });

  it("subtracts what was already used this pay week", () => {
    const h1 = heat({ heatId: "a" });
    const h2 = heat({ heatId: "b" });
    const one = computeEmployeeFreeHeats([item([h1, h2])], [sam], new Set(), [
      { memberId: "sam", usedThisWeek: 1 },
    ]);
    expect([...one.heats]).toEqual([h1]);
    const none = computeEmployeeFreeHeats([item([h1, h2])], [sam], new Set(), [
      { memberId: "sam", usedThisWeek: 2 },
    ]);
    expect(none.heats.size).toBe(0);
    expect(none.memberIds).toEqual([]);
  });

  it("gives EACH team member their own allowance — never pooled, never shared", () => {
    const s1 = heat({ heatId: "a" });
    const s2 = heat({ heatId: "b" });
    const s3 = heat({ heatId: "c" });
    const a1 = heat({ heatId: "d", assignedTo: "alex" });
    const a2 = heat({ heatId: "e", assignedTo: "alex" });
    const res = computeEmployeeFreeHeats(
      [item([s1, a1, s2, a2, s3])],
      [sam, alex, jordan],
      new Set(),
      [samEmp, alexEmp],
    );
    // Sam: 2 left → a, b (c stays paid). Alex: 1 left → d (e stays paid).
    expect([...res.heats]).toEqual([s1, a1, s2]);
    expect(res.memberIds.sort()).toEqual(["alex", "sam"]);
  });

  it("a stamped member with no matching employee entry frees nothing", () => {
    const h1 = heat({ heatId: "a" });
    const a1 = heat({ heatId: "d", assignedTo: "alex" });
    const res = computeEmployeeFreeHeats([item([h1, a1])], [sam, alex], new Set(), [alexEmp]);
    expect([...res.heats]).toEqual([a1]);
    expect(res.memberIds).toEqual(["alex"]);
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
      [samEmp],
    );
    expect([...res.heats]).toEqual([own]);
  });

  it("does nothing without a stamped member or without an employee", () => {
    const h1 = heat({ heatId: "a" });
    expect(computeEmployeeFreeHeats([item([h1])], [jordan], new Set(), [samEmp]).heats.size).toBe(
      0,
    );
    expect(computeEmployeeFreeHeats([item([h1])], [sam], new Set(), null).heats.size).toBe(0);
    expect(computeEmployeeFreeHeats([item([h1])], [sam], new Set(), []).heats.size).toBe(0);
  });

  it("ignores heats with no id and items with no date", () => {
    const pending = heat({ heatId: "" as unknown as string });
    expect(computeEmployeeFreeHeats([item([pending])], [sam], new Set(), [samEmp]).heats.size).toBe(
      0,
    );
    const h1 = heat({ heatId: "a" });
    expect(
      computeEmployeeFreeHeats([item([h1], { date: null })], [sam], new Set(), [samEmp]).heats.size,
    ).toBe(0);
  });
});

describe("employeeAttractionUnits", () => {
  it("counts the employee's assigned units on the kiosk", () => {
    const res = employeeAttractionUnits(
      { slug: "gel-blaster", qty: 3, participants: ["sam", "jordan", "sam"] },
      [sam, jordan],
    );
    expect(res).toEqual({ units: 2, percentOff: 50, byMember: [{ memberId: "sam", units: 2 }] });
  });

  it("counts every team member's own units, attributed per member", () => {
    const res = employeeAttractionUnits(
      { slug: "laser-tag", qty: 4, participants: ["sam", "alex", "jordan", "alex"] },
      [sam, alex, jordan],
    );
    expect(res.units).toBe(3);
    expect(res.percentOff).toBe(50);
    expect(res.byMember).toEqual([
      { memberId: "sam", units: 1 },
      { memberId: "alex", units: 2 },
    ]);
  });

  it("gives exactly one own unit per employee when nobody is named (web)", () => {
    expect(
      employeeAttractionUnits({ slug: "laser-tag", qty: 3, assignedTo: [] }, [sam, jordan]),
    ).toEqual({ units: 1, percentOff: 50, byMember: [{ memberId: "sam", units: 1 }] });
    expect(
      employeeAttractionUnits({ slug: "laser-tag", qty: 3, assignedTo: [] }, [sam, alex, jordan])
        .units,
    ).toBe(2);
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

  it("caps at the line quantity, serving members in party order", () => {
    expect(
      employeeAttractionUnits({ slug: "gel-blaster", qty: 1, participants: ["sam", "sam"] }, [sam])
        .units,
    ).toBe(1);
    const two = employeeAttractionUnits({ slug: "gel-blaster", qty: 1, assignedTo: [] }, [
      sam,
      alex,
    ]);
    expect(two.units).toBe(1);
    expect(two.byMember).toEqual([{ memberId: "sam", units: 1 }]);
  });
});

describe("discountedUnitCents", () => {
  it("rounds to the cent", () => {
    expect(discountedUnitCents(1999, 50)).toBe(1000);
    expect(discountedUnitCents(1799, 50)).toBe(900);
    expect(discountedUnitCents(1000, 0)).toBe(1000);
  });
});
