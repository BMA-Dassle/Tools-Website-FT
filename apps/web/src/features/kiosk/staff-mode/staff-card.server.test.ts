import { describe, expect, it } from "vitest";
import { isManagerGroup, verdictFromStaffRoles } from "./staff-card.server";

const person = { personId: "465243", firstName: "Stephanie", lastName: "Wegman" };

/** The owner's live sample (2026-09-04). */
const sample = {
  success: true,
  data: {
    personID: "465243",
    firstName: "Stephanie",
    lastName: "Wegman",
    isStaff: true,
    userID: "465242",
    username: "Stephanie",
    userBlocked: false,
    groups: [
      { id: "-3", name: "Accountant" },
      { id: "-2", name: "Manager" },
      { id: "-9", name: "Pos User" },
      { id: "-1", name: "User" },
    ],
    teams: [{ id: "3978730", name: "Sales", roleID: "-2", role: "Member" }],
  },
};

describe("verdictFromStaffRoles", () => {
  it("a Manager opens the menu, named from the payload, role = the Manager group", () => {
    expect(verdictFromStaffRoles(person, sample, "0001063464")).toEqual({
      kind: "manager",
      employee: { id: "465243", name: "Stephanie Wegman", role: "Manager", cardTail: "3464" },
    });
  });

  it('any group CONTAINING "Manager" counts (owner: "any role with Manager")', () => {
    const p = { ...sample, data: { ...sample.data, groups: [{ id: "7", name: "Shift manager" }] } };
    const v = verdictFromStaffRoles(person, p, "1063464");
    expect(v.kind).toBe("manager");
    expect(v.kind === "manager" && v.employee.role).toBe("Shift manager");
    expect(isManagerGroup("Assistant Manager")).toBe(true);
    expect(isManagerGroup("Pos User")).toBe(false);
  });

  it("staff without a Manager group → not-manager, with the name for the notice", () => {
    const p = {
      ...sample,
      data: {
        ...sample.data,
        groups: [
          { id: "-9", name: "Pos User" },
          { id: "-1", name: "User" },
        ],
      },
    };
    expect(verdictFromStaffRoles(person, p, "1063464")).toEqual({
      kind: "not-manager",
      name: "Stephanie Wegman",
    });
  });

  it("not staff, blocked, success:false, or junk → not-staff", () => {
    expect(
      verdictFromStaffRoles(person, { ...sample, data: { ...sample.data, isStaff: false } }, "1"),
    ).toEqual({ kind: "not-staff" });
    expect(
      verdictFromStaffRoles(
        person,
        { ...sample, data: { ...sample.data, userBlocked: true } },
        "1",
      ),
    ).toEqual({ kind: "not-staff" });
    expect(verdictFromStaffRoles(person, { success: false }, "1")).toEqual({ kind: "not-staff" });
    expect(verdictFromStaffRoles(person, null, "1")).toEqual({ kind: "not-staff" });
    expect(verdictFromStaffRoles(person, "nope", "1")).toEqual({ kind: "not-staff" });
  });

  it("falls back to the Office name when the payload has none", () => {
    const p = { success: true, data: { isStaff: true, groups: [{ name: "Manager" }] } };
    const v = verdictFromStaffRoles(person, p, "1063464");
    expect(v.kind === "manager" && v.employee).toEqual({
      id: "465243",
      name: "Stephanie Wegman",
      role: "Manager",
      cardTail: "3464",
    });
  });
});
