import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * getReservationsByContact is the customer dashboard's authorization boundary:
 * a phone-typed session must match ONLY guest_phone, an email-typed session ONLY
 * guest_email — never both (a recycled phone could otherwise leak a stranger's
 * bookings). We capture the SQL text through a mocked `sql` tag and assert the
 * single-channel predicate. Phone matches on normalized last-10-digits to line
 * up with the br_guest_phone10 functional index.
 */

const queries: string[] = [];

vi.mock("@/lib/db", () => {
  const tag = (strings: TemplateStringsArray, ..._values: unknown[]) => {
    queries.push(strings.join("$?"));
    return Promise.resolve([]);
  };
  return { isDbConfigured: () => true, sql: () => tag };
});

import { getReservationsByContact } from "./bowling-db";

beforeEach(() => {
  queries.length = 0;
});

const phonePred = () => queries.find((q) => q.includes("regexp_replace(s.guest_phone"));
const emailPred = () => queries.find((q) => q.includes("lower(s.guest_email)"));

describe("getReservationsByContact — single-channel matching", () => {
  it("phone session matches normalized guest_phone, NOT email", async () => {
    await getReservationsByContact({ phone: "+12395551234" });
    expect(phonePred(), "phone predicate issued").toBeTruthy();
    expect(phonePred()).toContain("right(regexp_replace(s.guest_phone,'\\D','','g'),10)");
    expect(emailPred(), "must NOT issue an email predicate").toBeFalsy();
  });

  it("email session matches lower(guest_email), NOT phone", async () => {
    await getReservationsByContact({ email: "Person@Example.com" });
    expect(emailPred(), "email predicate issued").toBeTruthy();
    expect(phonePred(), "must NOT issue a phone predicate").toBeFalsy();
  });

  it("returns [] without querying when neither channel is usable", async () => {
    const rows = await getReservationsByContact({ phone: "12" });
    expect(rows).toEqual([]);
    expect(queries.length).toBe(0);
  });
});
