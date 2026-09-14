import { describe, expect, it } from "vitest";

import {
  EMPLOYEE_ENTITLEMENT,
  employeeGameZoneCredit,
  firstNamesMatchLeniently,
  freeRacesRemaining,
  matchEmployeeToParty,
  normalizeNameToken,
  payWeekKey,
  stampEmployeeOnParty,
} from "./employee";

const staff = {
  firstName: "Sam",
  legalFirstName: "Samantha",
  lastName: "Ortiz",
  mobile: "+12395554417",
};

describe("payWeekKey", () => {
  it("keys every day of a Wed–Tue pay week to its Wednesday (ET)", () => {
    // 2026-09-16 is a Wednesday. Thu 17 … Tue 22 share it; Wed 23 starts the next.
    expect(payWeekKey(new Date("2026-09-16T15:00:00Z"))).toBe("2026-09-16");
    expect(payWeekKey(new Date("2026-09-19T15:00:00Z"))).toBe("2026-09-16");
    expect(payWeekKey(new Date("2026-09-22T23:00:00Z"))).toBe("2026-09-16");
    expect(payWeekKey(new Date("2026-09-23T15:00:00Z"))).toBe("2026-09-23");
  });

  it("rolls at ET midnight, not UTC", () => {
    // 03:30Z on Wed Sep 23 is still Tue Sep 22 in New York (EDT, UTC-4).
    expect(payWeekKey(new Date("2026-09-23T03:30:00Z"))).toBe("2026-09-16");
  });
});

describe("normalizeNameToken / firstNamesMatchLeniently", () => {
  it("strips case, spaces, punctuation and accents", () => {
    expect(normalizeNameToken("  O'Brien ")).toBe("obrien");
    expect(normalizeNameToken("José")).toBe("jose");
    expect(normalizeNameToken("Van Der Berg")).toBe("vanderberg");
  });

  it("matches nicknames by a 3+ letter prefix, either direction", () => {
    expect(firstNamesMatchLeniently("Sam", "Samantha")).toBe(true);
    expect(firstNamesMatchLeniently("ALEXANDER", "alex")).toBe(true);
    expect(firstNamesMatchLeniently("Sam", "Sam")).toBe(true);
  });

  it("refuses two-letter prefixes and unrelated names", () => {
    expect(firstNamesMatchLeniently("Jo", "Joseph")).toBe(false);
    expect(firstNamesMatchLeniently("Sam", "Jordan")).toBe(false);
    expect(firstNamesMatchLeniently("", "Sam")).toBe(false);
  });
});

describe("matchEmployeeToParty", () => {
  it("links the one member with the surname and a matching phone", () => {
    const res = matchEmployeeToParty(staff, [
      { id: "a", firstName: "Jordan", lastName: "Reyes", bmiPersonId: "1" },
      { id: "b", firstName: "S.", lastName: "Ortiz", phone: "(239) 555-4417", bmiPersonId: "2" },
    ]);
    expect(res).toEqual({ ok: true, memberId: "b", matchedBy: "phone" });
  });

  it("links on surname + lenient first name when the phone differs", () => {
    const res = matchEmployeeToParty(staff, [
      { id: "b", firstName: "Samantha", lastName: "ORTIZ", phone: "2395550000", bmiPersonId: "2" },
    ]);
    expect(res).toEqual({ ok: true, memberId: "b", matchedBy: "first-name" });
  });

  it("does NOT link a same-surname relative who fails both legs", () => {
    const res = matchEmployeeToParty(staff, [
      { id: "spouse", firstName: "Miguel", lastName: "Ortiz", phone: "2395550000", bmiPersonId: "3" },
    ]);
    expect(res).toEqual({ ok: false, reason: "none" });
  });

  it("never links on phone alone when the surname differs", () => {
    const res = matchEmployeeToParty(staff, [
      { id: "x", firstName: "Sam", lastName: "Reyes", phone: "2395554417", bmiPersonId: "4" },
    ]);
    expect(res).toEqual({ ok: false, reason: "none" });
  });

  it("ignores hand-typed members (no BMI person) unless allowed", () => {
    const typed = [{ id: "t", firstName: "Sam", lastName: "Ortiz" }];
    expect(matchEmployeeToParty(staff, typed)).toEqual({ ok: false, reason: "none" });
    expect(matchEmployeeToParty(staff, typed, { allowUnlinked: true })).toEqual({
      ok: true,
      memberId: "t",
      matchedBy: "first-name",
    });
  });

  it("lets the phone decide between two passing family members, else refuses", () => {
    const twins = [
      { id: "s1", firstName: "Sam", lastName: "Ortiz", phone: "2395550001", bmiPersonId: "5" },
      { id: "s2", firstName: "Sammy", lastName: "Ortiz", phone: "2395554417", bmiPersonId: "6" },
    ];
    expect(matchEmployeeToParty(staff, twins)).toEqual({ ok: true, memberId: "s2", matchedBy: "phone" });
    const noPhone = twins.map((t) => ({ ...t, phone: null }));
    expect(matchEmployeeToParty(staff, noPhone)).toEqual({ ok: false, reason: "ambiguous" });
  });
});

describe("employeeGameZoneCredit", () => {
  it("loads the bought tokens again as bonus, on top of any pack bonus, price untouched", () => {
    expect(employeeGameZoneCredit({ tokens: 100, bonusTokens: 0 })).toEqual({ tokens: 100, bonusTokens: 100 });
    expect(employeeGameZoneCredit({ tokens: 300, bonusTokens: 50 })).toEqual({ tokens: 300, bonusTokens: 350 });
  });
});

describe("freeRacesRemaining", () => {
  it("counts down from two per pay week and never goes negative", () => {
    expect(freeRacesRemaining(null)).toBe(0);
    expect(freeRacesRemaining({ usedThisWeek: 0 })).toBe(2);
    expect(freeRacesRemaining({ usedThisWeek: 1 })).toBe(1);
    expect(freeRacesRemaining({ usedThisWeek: 5 })).toBe(0);
  });
});

describe("stampEmployeeOnParty", () => {
  const party = [
    { id: "a", firstName: "Jordan", employeePerks: { userId: 9, firstName: "Old" } },
    { id: "b", firstName: "Sam" },
  ];

  it("stamps exactly the matched member and clears every other stamp", () => {
    const out = stampEmployeeOnParty(party, { userId: 42, firstName: "Sam", memberId: "b" });
    expect(out[0].employeePerks).toBeUndefined();
    expect(out[1].employeePerks).toEqual({ userId: 42, firstName: "Sam" });
  });

  it("clears all stamps when there is no employee or no match", () => {
    expect(stampEmployeeOnParty(party, null).every((m) => !m.employeePerks)).toBe(true);
    expect(
      stampEmployeeOnParty(party, { userId: 42, firstName: "Sam", memberId: null }).every(
        (m) => !m.employeePerks,
      ),
    ).toBe(true);
  });
});

describe("EMPLOYEE_ENTITLEMENT", () => {
  it("shares the Employee Pass key so the membership fallback can never stack", () => {
    expect(EMPLOYEE_ENTITLEMENT.key).toBe("employee-pass");
    expect(EMPLOYEE_ENTITLEMENT.percentOff).toBe(50);
    expect(EMPLOYEE_ENTITLEMENT.categories).toEqual(["racing", "gel-blasters", "laser-tag"]);
  });
});
