/**
 * The charge-time reconcile with SEVERAL team members on one booking (owner
 * 2026-09-14). Everything around it — 7shifts, Neon, SMS, BMI search — is
 * stubbed; the signed tokens are real (minted with the test secret).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/sms-retry", () => ({ voxSend: vi.fn(async () => ({ ok: true })) }));
vi.mock("~/features/account/data/otp-store", () => ({
  consumeOtp: vi.fn(),
  generateCode: vi.fn(() => "123456"),
  reserveSend: vi.fn(async () => ({ blocked: false })),
  storeOtp: vi.fn(),
}));
vi.mock("~/features/account/contact", () => ({ maskValue: (v: string) => v.slice(-4) }));
vi.mock("~/features/kiosk/license/lookup.server", () => ({
  lookupLicenseMatches: vi.fn(async () => []),
  clientKeyForLookup: () => "headpinzftmyers",
}));
vi.mock("./employee-data", () => ({
  countFreeRacesUsed: vi.fn(async () => 0),
  getEmployeeLinkForPerson: vi.fn(async () => null),
  touchEmployeeLink: vi.fn(async () => undefined),
  upsertEmployeeLink: vi.fn(async () => null),
}));

const ROSTER: Record<number, { firstName: string; lastName: string }> = {
  42: { firstName: "Sam", lastName: "Ortiz" },
  77: { firstName: "Alex", lastName: "Reyes" },
};
vi.mock("~/features/staff/service", () => ({
  resolveEmployee: vi.fn(),
  getStaffRecord: vi.fn(async (userId: number) => {
    const r = ROSTER[userId];
    if (!r) return { ok: false, reason: "unknown" };
    return {
      ok: true,
      stale: false,
      staff: {
        userId,
        punchId: String(userId),
        firstName: r.firstName,
        legalFirstName: r.firstName,
        lastName: r.lastName,
        mobile: "+12395550000",
        email: null,
        employeeId: null,
        birthDate: null,
      },
    };
  }),
}));

import {
  applyEmployeeToSession,
  mintEmployeeToken,
  type EmployeeSessionLike,
} from "./employee.server";
import type { SessionEmployee } from "./employee";

const party: Array<EmployeeSessionLike["party"][number] & { firstName: string }> = [
  { id: "sam", firstName: "Sam", bmiPersonId: "409523" },
  { id: "alex", firstName: "Alex", bmiPersonId: "63000000009561437" },
  { id: "jordan", firstName: "Jordan" },
];

function claim(
  userId: number,
  firstName: string,
  memberId: string | null,
  over: Partial<SessionEmployee> = {},
): SessionEmployee {
  return {
    userId,
    firstName,
    memberId,
    token: mintEmployeeToken({
      userId,
      firstName,
      memberId,
      bmiPersonId: party.find((p) => p.id === memberId)?.bmiPersonId ?? null,
    }),
    usedThisWeek: 0,
    weekKey: "2026-09-09",
    ...over,
  };
}

describe("applyEmployeeToSession — several team members", () => {
  const saved = { ...process.env };
  beforeEach(() => {
    process.env.EMPLOYEE_PERKS_SIGNING_SECRET = "test-secret";
    delete process.env.EMPLOYEE_PERKS;
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  it("verifies EVERY token and stamps exactly those members", async () => {
    const res = await applyEmployeeToSession({
      party: party.map((p) => ({ ...p, employeePerks: { userId: 1, firstName: "Forged" } })),
      employees: [claim(42, "Sam", "sam"), claim(77, "Alex", "alex")],
    });
    expect(res.dropped).toEqual([]);
    expect(res.employees.map((e) => [e.userId, e.memberId])).toEqual([
      [42, "sam"],
      [77, "alex"],
    ]);
    expect(res.session.employees?.map((e) => e.userId)).toEqual([42, 77]);
    expect(res.session.party.map((m) => m.employeePerks?.userId)).toEqual([42, 77, undefined]);
  });

  it("drops the one bad claim and keeps the other employee's perks", async () => {
    const res = await applyEmployeeToSession({
      party,
      employees: [
        { ...claim(42, "Sam", "sam"), token: "emp.0.garbage.sig" },
        claim(77, "Alex", "alex"),
      ],
    });
    expect(res.dropped).toEqual(["bad-token"]);
    expect(res.employees.map((e) => e.userId)).toEqual([77]);
    expect(res.session.party.map((m) => !!m.employeePerks)).toEqual([false, true, false]);
  });

  it("a 7shifts user appears once; a party member is one employee's only", async () => {
    const res = await applyEmployeeToSession({
      party,
      employees: [
        claim(42, "Sam", "sam"),
        claim(42, "Sam", "sam", { usedThisWeek: 1 }),
        claim(77, "Alex", "sam"),
      ],
    });
    expect(res.dropped).toEqual(["duplicate", "duplicate"]);
    expect(res.employees.map((e) => e.userId)).toEqual([42]);
  });

  it("someone no longer on the roster is dropped; the active colleague is kept", async () => {
    const res = await applyEmployeeToSession({
      party,
      employees: [claim(42, "Sam", "sam"), claim(999, "Gone", "alex")],
    });
    expect(res.dropped).toEqual(["inactive"]);
    expect(res.employees.map((e) => e.userId)).toEqual([42]);
  });

  it("an unmatched token (no member yet) and a member who left the party both drop", async () => {
    const res = await applyEmployeeToSession({
      party: [party[0]],
      employees: [claim(42, "Sam", null), claim(77, "Alex", "alex")],
    });
    expect(res.dropped).toEqual(["unmatched", "member-missing"]);
    expect(res.employees).toEqual([]);
    expect(res.session.employees).toEqual([]);
  });

  it("honours the pre-09-14 single `employee` field and rewrites it as the list", async () => {
    const legacy: EmployeeSessionLike = { party, employee: claim(42, "Sam", "sam") };
    const res = await applyEmployeeToSession(legacy);
    expect(res.employees.map((e) => e.userId)).toEqual([42]);
    expect(res.session.employees?.map((e) => e.userId)).toEqual([42]);
    expect(res.session.employee).toBeUndefined();
  });

  it("the kill switch drops everyone", async () => {
    process.env.EMPLOYEE_PERKS = "false";
    const res = await applyEmployeeToSession({
      party,
      employees: [claim(42, "Sam", "sam"), claim(77, "Alex", "alex")],
    });
    expect(res.dropped).toEqual(["disabled", "disabled"]);
    expect(res.employees).toEqual([]);
    expect(res.session.party.every((m) => !m.employeePerks)).toBe(true);
  });
});
