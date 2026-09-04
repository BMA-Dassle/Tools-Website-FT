import { describe, expect, it } from "vitest";

import { buildPunchIndex, isActiveUser, staffFirstName, staffFromUser } from "./punch-index";
import type { SevenShiftsUser } from "~/lib/api/sevenshifts";

function user(over: Partial<SevenShiftsUser> & { id: number }): SevenShiftsUser {
  return { first_name: "Ada", last_name: "Lovelace", punch_id: "1234", ...over };
}

describe("isActiveUser", () => {
  it("treats a user with neither flag as active", () => {
    // A company that has never deactivated anyone returns neither field;
    // failing closed here would lock out the entire roster.
    expect(isActiveUser(user({ id: 1 }))).toBe(true);
  });

  it("rejects active:false even when status says otherwise", () => {
    expect(isActiveUser(user({ id: 1, active: false, status: "active" }))).toBe(false);
  });

  it("rejects a non-active status string", () => {
    expect(isActiveUser(user({ id: 1, status: "inactive" }))).toBe(false);
    expect(isActiveUser(user({ id: 1, status: "terminated" }))).toBe(false);
  });

  it("accepts status regardless of case or padding", () => {
    expect(isActiveUser(user({ id: 1, status: " Active " }))).toBe(true);
  });
});

describe("staffFirstName", () => {
  it("prefers the preferred first name", () => {
    expect(staffFirstName(user({ id: 1, first_name: "Robert", preferred_first_name: "Bob" }))).toBe(
      "Bob",
    );
  });

  it("falls back to the legal name when preferred is empty", () => {
    expect(staffFirstName(user({ id: 1, first_name: "Robert", preferred_first_name: "" }))).toBe(
      "Robert",
    );
  });
});

describe("staffFromUser", () => {
  it("keys on the 7shifts user id, not the punch id", () => {
    const staff = staffFromUser(user({ id: 998877, punch_id: "42" }));
    expect(staff).toEqual({
      userId: 998877,
      punchId: "42",
      firstName: "Ada",
      lastName: "Lovelace",
    });
  });

  it("trims a padded punch id so it matches what the keypad sends", () => {
    expect(staffFromUser(user({ id: 1, punch_id: " 42 " }))?.punchId).toBe("42");
  });

  it("returns null without a punch id — nothing to type", () => {
    expect(staffFromUser(user({ id: 1, punch_id: null }))).toBeNull();
    expect(staffFromUser(user({ id: 1, punch_id: "" }))).toBeNull();
  });

  it("returns null without a first name — a blank chip on a board is worse than none", () => {
    expect(staffFromUser(user({ id: 1, first_name: "", preferred_first_name: null }))).toBeNull();
  });

  it("returns null for an inactive user", () => {
    expect(staffFromUser(user({ id: 1, active: false }))).toBeNull();
  });
});

describe("buildPunchIndex", () => {
  it("maps each punch id to its holder", () => {
    const { index, size, collisions } = buildPunchIndex([
      user({ id: 1, punch_id: "100", first_name: "Ada" }),
      user({ id: 2, punch_id: "2001", first_name: "Grace" }),
    ]);
    expect(size).toBe(2);
    expect(collisions).toEqual([]);
    expect(index["100"].userId).toBe(1);
    expect(index["2001"].firstName).toBe("Grace");
  });

  it("handles variable-length punch ids", () => {
    const { index } = buildPunchIndex([
      user({ id: 1, punch_id: "7" }),
      user({ id: 2, punch_id: "1234567" }),
    ]);
    expect(index["7"].userId).toBe(1);
    expect(index["1234567"].userId).toBe(2);
  });

  it("EXCLUDES a punch id two active people share, rather than picking one", () => {
    // The consequence of guessing here is a session signed by the wrong person
    // that nobody notices until payroll — so the id resolves to nobody.
    const { index, collisions } = buildPunchIndex([
      user({ id: 1, punch_id: "55", first_name: "Ada" }),
      user({ id: 2, punch_id: "55", first_name: "Grace" }),
    ]);
    expect(collisions).toEqual(["55"]);
    expect(index["55"]).toBeUndefined();
  });

  it("does not treat a departed employee's id as a collision", () => {
    // The common real-world case: a punch id reissued after someone left.
    const { index, collisions } = buildPunchIndex([
      user({ id: 1, punch_id: "55", first_name: "Ada", active: false }),
      user({ id: 2, punch_id: "55", first_name: "Grace" }),
    ]);
    expect(collisions).toEqual([]);
    expect(index["55"].firstName).toBe("Grace");
  });

  it("skips users who cannot hold an identity", () => {
    const { size } = buildPunchIndex([
      user({ id: 1, punch_id: null }),
      user({ id: 2, first_name: "", preferred_first_name: null }),
      user({ id: 3, active: false }),
      user({ id: 4, punch_id: "9" }),
    ]);
    expect(size).toBe(1);
  });
});
