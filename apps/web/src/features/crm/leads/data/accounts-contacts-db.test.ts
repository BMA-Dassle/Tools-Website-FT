import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The account / contact upserts the BMI mirror links hosts through (B1), at
 * the SQL boundary: find-or-create on `(kind, name_key)`, the contact match
 * order (person id → phone → email), and the lifetime roll-up.
 */

const db = await vi.hoisted(async () =>
  (await import("@/test/stubs/recording-sql")).makeRecordingSql(),
);
vi.mock("@ft/db", () => ({ sql: () => db.q, isDbConfigured: () => true }));

const accounts = await import("./accounts-db");
const contacts = await import("./contacts-db");

const ACCOUNT_ROW = {
  id: "12",
  kind: "business",
  name: "Acme Corp., Inc.",
  name_key: "acme",
  centre: "HPFM",
  lifetime_cents: "1426000",
  meta: null,
  archived_at: null,
  created_at: "2026-09-12 23:00:00+00",
  updated_at: "2026-09-12 23:00:00+00",
};

const CONTACT_ROW = {
  id: "34",
  account_id: "12",
  first_name: "Dana",
  last_name: "Acme",
  phone_e164: "+12395554021",
  email: "Dana@AcmeCorp.com",
  email_key: "dana@acmecorp.com",
  bmi_person_id: "63000000009561437",
  prefers: null,
  meta: null,
  created_at: "2026-09-12 23:00:00+00",
  updated_at: "2026-09-12 23:00:00+00",
};

beforeEach(() => db.reset());

describe("upsertAccountByKey", () => {
  it("INSERT … ON CONFLICT (kind, name_key) keeps the existing centre and name", async () => {
    db.respond = () => [ACCOUNT_ROW];
    const a = await accounts.upsertAccountByKey({
      kind: "business",
      name: "Acme Corp., Inc.",
      nameKey: "acme",
      centre: "HPFM",
    });
    expect(a).toMatchObject({
      id: "12",
      kind: "business",
      nameKey: "acme",
      lifetimeCents: 1_426_000,
      centre: "HPFM",
    });
    const s = db.matching(/INSERT INTO crm_accounts/)[0]!;
    expect(s.text).toContain("ON CONFLICT (kind, name_key) DO UPDATE SET");
    expect(s.text).toContain("centre = COALESCE(a.centre, EXCLUDED.centre)");
    expect(s.text).not.toContain("name = EXCLUDED.name");
    expect(s.params).toEqual(["business", "Acme Corp., Inc.", "acme", "HPFM"]);
    // The schema (memoised once per process, so asserted on this first call)
    // adds the unique (kind, name_key) index the ON CONFLICT needs.
    expect(db.matching(/CREATE UNIQUE INDEX IF NOT EXISTS crm_accounts_kind_key/)).toHaveLength(1);
  });

  it("refreshAccountLifetime sums non-cancelled group events per account, only for numeric ids", async () => {
    await accounts.refreshAccountLifetime(["12", "x", "12", "13"]);
    const s = db.matching(/UPDATE crm_accounts a/)[0]!;
    expect(s.text).toContain("SUM(p.total_value_cents)");
    expect(s.text).toContain("p.kind_id IS DISTINCT FROM '-10'");
    expect(s.text).toContain("p.state_id IS DISTINCT FROM '-4'");
    expect(s.params).toEqual([["12", "13"]]);
    db.reset();
    await accounts.refreshAccountLifetime([]);
    expect(db.statements).toHaveLength(0);
  });

  it("searchAccounts: name, contact name, email key, phone digits; empty q lists; keyset on id", async () => {
    db.respond = () => [];
    await accounts.searchAccounts("Acme 555-4021", { limit: 10, cursor: "40" });
    const s = db.matching(/FROM crm_accounts a/)[0]!;
    expect(s.text).toContain("a.name ILIKE $2");
    expect(s.text).toContain("(c.first_name || ' ' || c.last_name) ILIKE $2");
    expect(s.text).toContain("c.email_key LIKE lower($2)");
    expect(s.text).toContain("c.phone_e164 LIKE '%' || $3 || '%'");
    expect(s.text).toContain("a.id < $4::bigint");
    expect(s.params).toEqual(["Acme 555-4021", "%Acme 555-4021%", "5554021", "40", 11]);
  });
});

describe("upsertContactFromBmi", () => {
  const input = {
    firstName: "Dana",
    lastName: "Acme",
    phoneE164: "+12395554021",
    email: "Dana@AcmeCorp.com",
    emailKey: "dana@acmecorp.com",
    bmiPersonId: "63000000009561437",
    accountId: "12",
  };

  it("matches by person id first, then phone, then email; a match is UPDATED with COALESCE only", async () => {
    db.respond = (s) =>
      /FROM crm_contacts c/.test(s.text)
        ? [{ ...CONTACT_ROW, rank: 1 }]
        : /UPDATE crm_contacts/.test(s.text)
          ? [CONTACT_ROW]
          : [];
    const r = await contacts.upsertContactFromBmi(input);
    expect(r.created).toBe(false);
    expect(r.contact.id).toBe("34");
    const find = db.matching(/FROM crm_contacts c/)[0]!;
    expect(find.text).toContain("c.bmi_person_id = $1 THEN 0");
    expect(find.text).toContain("c.phone_e164 = $2 THEN 1");
    expect(find.text).toContain("c.email_key = $3 THEN 2");
    expect(find.text).toContain("ORDER BY rank ASC, c.id ASC");
    expect(find.params).toEqual(["63000000009561437", "+12395554021", "dana@acmecorp.com"]);
    const upd = db.matching(/UPDATE crm_contacts c/)[0]!;
    expect(upd.text).toContain("bmi_person_id = COALESCE(c.bmi_person_id, $2)");
    expect(upd.text).toContain(
      "first_name = CASE WHEN c.first_name = '' THEN $6 ELSE c.first_name END",
    );
    expect(upd.text).toContain("account_id = COALESCE(c.account_id, $8::bigint)");
    expect(upd.params[0]).toBe("34");
    expect(upd.params[1]).toBe("63000000009561437");
  });

  it("no match → INSERT tagged source bmi-mirror", async () => {
    db.respond = (s) => (/INSERT INTO crm_contacts/.test(s.text) ? [CONTACT_ROW] : []);
    const r = await contacts.upsertContactFromBmi(input);
    expect(r.created).toBe(true);
    const ins = db.matching(/INSERT INTO crm_contacts/)[0]!;
    // RETURNING uses the `c.` columns, so the INSERT must carry the alias (the
    // first live smoke failed every new host with "missing FROM-clause entry for table c").
    expect(ins.text).toContain("INSERT INTO crm_contacts AS c (");
    expect(ins.params).toEqual([
      "12",
      "Dana",
      "Acme",
      "+12395554021",
      "Dana@AcmeCorp.com",
      "dana@acmecorp.com",
      "63000000009561437",
      JSON.stringify({ source: "bmi-mirror" }),
    ]);
  });

  it("mapContactRow keeps ids as strings and validates prefers", () => {
    const c = contacts.mapContactRow({ ...CONTACT_ROW, prefers: "carrier-pigeon" });
    expect(c.bmiPersonId).toBe("63000000009561437");
    expect(c.accountId).toBe("12");
    expect(c.prefers).toBeNull();
  });
});
