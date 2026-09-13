import { describe, expect, it } from "vitest";
import {
  GS_DEPARTMENT_ID,
  GS_DEPARTMENT_NAME,
  SEVEN_SHIFTS_SETTING_DEFAULT,
  SEVEN_SHIFTS_SETTING_KEY,
  departmentIdsFrom,
  sevenShiftsSettingFrom,
} from "./settings";

/**
 * `crm_settings.sevenshifts` — the department(s) whose shifts make the Guest
 * Services bucket "on shift" (owner, 2026-09-13). The seeded value is the ONE
 * id the owner named; the shape is a list so a second call centre needs no
 * migration.
 */

describe("sevenShiftsSettingFrom", () => {
  it("no row, null or junk = the department the owner named", () => {
    for (const value of [undefined, null, "nope", 7, [], { gsDepartmentIds: "635186" }]) {
      expect(sevenShiftsSettingFrom(value)).toEqual({
        gsDepartmentIds: [635186],
        gsDepartmentName: "Call Center",
      });
    }
    expect(SEVEN_SHIFTS_SETTING_DEFAULT.gsDepartmentIds).toEqual([GS_DEPARTMENT_ID]);
    expect(SEVEN_SHIFTS_SETTING_DEFAULT.gsDepartmentName).toBe(GS_DEPARTMENT_NAME);
    expect(SEVEN_SHIFTS_SETTING_KEY).toBe("sevenshifts");
  });

  it("a stored list is honoured, including a deliberate empty one", () => {
    expect(sevenShiftsSettingFrom({ gsDepartmentIds: [635186, 730648] })).toEqual({
      gsDepartmentIds: [635186, 730648],
      gsDepartmentName: "Call Center",
    });
    // A director who clears the list is saying "no department covers the
    // bucket" — that is a stored value, not a missing row.
    expect(sevenShiftsSettingFrom({ gsDepartmentIds: [] }).gsDepartmentIds).toEqual([]);
  });

  it("a stored name is kept; a blank one falls back", () => {
    expect(
      sevenShiftsSettingFrom({ gsDepartmentIds: [1], gsDepartmentName: " Call Centre " }),
    ).toEqual({ gsDepartmentIds: [1], gsDepartmentName: "Call Centre" });
    expect(
      sevenShiftsSettingFrom({ gsDepartmentIds: [1], gsDepartmentName: "  " }).gsDepartmentName,
    ).toBe(GS_DEPARTMENT_NAME);
  });
});

describe("departmentIdsFrom", () => {
  it("keeps positive 32-bit ints, de-duplicates, drops the rest; null when not a list", () => {
    expect(departmentIdsFrom([635186, "730648", 635186, 0, -1, 1.5, "x", 3e10])).toEqual([
      635186, 730648,
    ]);
    expect(departmentIdsFrom("635186")).toBeNull();
    expect(departmentIdsFrom(undefined)).toBeNull();
  });
});
