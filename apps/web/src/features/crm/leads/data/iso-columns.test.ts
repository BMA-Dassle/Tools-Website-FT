import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Every timestamp the leads sub hands a client is ISO-8601 UTC.
 *
 * `contacts-db` and `accounts-db` used to select `created_at::text`, which
 * Neon renders in Postgres' own format (`2026-09-13 12:34:56.789+00`) while
 * `leads-db` and the timeline emit `…T…Z`. `CrmContact.createdAt` /
 * `CrmAccount.createdAt` are consumed as ISO strings, so the type was a lie
 * for those two tables — invisible in B3, a trap for the PRs that surface
 * account and contact history. Asserted at the SQL boundary, like
 * `leads-db.test.ts`.
 */

const db = await vi.hoisted(async () =>
  (await import("@/test/stubs/recording-sql")).makeRecordingSql(),
);
vi.mock("@ft/db", () => ({
  sql: () => db.q,
  isDbConfigured: () => true,
  parseWithRawIds: (t: string) => JSON.parse(t),
  BMI_ID_FIELDS: ["id"],
}));

const { ISO } = await import("./sql");
const { getContact } = await import("./contacts-db");
const { upsertAccountByName } = await import("./accounts-db");
const { LEAD_SELECT } = await import("./leads-db");

beforeEach(() => db.reset());

const selects = (table: RegExp) => db.statements.filter((s) => table.test(s.text));

describe("ISO()", () => {
  it("emits ISO-8601 UTC text, not a bare ::text cast", () => {
    expect(ISO("created_at")).toBe(
      `to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`,
    );
  });
});

describe("the emitted SQL", () => {
  it("crm_contacts reads created_at / updated_at through ISO()", async () => {
    await getContact("9");
    const [stmt] = selects(/FROM crm_contacts WHERE id/);
    expect(stmt).toBeDefined();
    expect(stmt!.text).toContain(`${ISO("created_at")} AS created_at`);
    expect(stmt!.text).toContain(`${ISO("updated_at")} AS updated_at`);
    expect(stmt!.text).not.toContain("created_at::text");
  });

  it("crm_accounts reads created_at / updated_at / archived_at through ISO()", async () => {
    await upsertAccountByName({ name: "Gulf Coast Dental", kind: "business", centre: "FT" });
    const [stmt] = selects(/FROM crm_accounts WHERE name_key/);
    expect(stmt).toBeDefined();
    for (const col of ["created_at", "updated_at", "archived_at"])
      expect(stmt!.text).toContain(`${ISO(col)} AS ${col}`);
    expect(stmt!.text).not.toContain("::text AS archived_at");
  });

  it("crm_leads already did, and still shares the one helper", () => {
    expect(LEAD_SELECT).toContain(`${ISO("l.created_at")} AS created_at`);
  });
});
