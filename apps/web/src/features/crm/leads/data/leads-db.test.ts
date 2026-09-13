import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The SQL boundary (brief §3.10): the INSERT mints `public_id` in the same
 * statement, the patch builder refuses unknown columns, the list is keyset
 * with `limit ≤ 200`, and the row mapper keeps ids and dates as strings.
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

const {
  buildLeadSet,
  decodeCursor,
  encodeCursor,
  insertLead,
  leadNumericId,
  listLeads,
  mapLeadRow,
  volumeByRepMonth,
} = await import("./leads-db");

beforeEach(() => db.reset());

const RAW = {
  id: "1061",
  public_id: "L-1061",
  contact_id: "9",
  account_id: "7",
  centre: "FT",
  event_date: "2026-10-16",
  event_time: "17:30",
  guests: 42,
  event_type: "corporate",
  source: "web",
  is_prospect: false,
  kids: false,
  status_id: "new",
  assigned_rep_id: null,
  assigned_at: null,
  held_for_rep_id: null,
  first_touch_at: null,
  next_action_kind: null,
  next_action_due: null,
  next_action_label: null,
  value_cents: "0",
  lost_reason: null,
  notes: null,
  bmi_project_id: "63000000009561437",
  bmi_project_number: "DH2891",
  bmi_state_id: null,
  bmi_state_name: "New Lead",
  bmi_person_id: "63000000009561438",
  bmi_synced_at: "2026-09-12T23:22:00.000Z",
  mint_status: "minted",
  mint_error: null,
  mint_attempts: 1,
  gf_short_id: null,
  last_year_bmi_project_id: null,
  cold_row_id: null,
  created_by: null,
  created_at: "2026-09-12T23:22:00.000Z",
  updated_at: "2026-09-12T23:22:00.000Z",
  archived_at: null,
  c_first_name: "Marcus",
  c_last_name: "Bellamy",
  c_phone_e164: "+12395552710",
  c_email: "marcus@example.com",
  c_prefers: "text",
  a_name: "Gulf Coast Logistics",
  r_slug: null,
  r_display_name: null,
  requested_rep_id: "1",
  rq_slug: "kelsea",
  rq_first_name: "Kelsea",
  rq_display_name: "Kelsea Kosco",
};

describe("insertLead", () => {
  it("mints public_id = 'L-' || id from nextval in ONE statement and returns the id", async () => {
    db.respond = () => [{ id: "1061" }];
    const id = await insertLead({
      contactId: "9",
      accountId: "7",
      centre: "FT",
      eventDate: "2026-10-16",
      eventTime: "17:30",
      guests: 42,
      type: "corporate",
      source: "web",
      isProspect: false,
      kids: false,
      notes: null,
      mintStatus: "pending",
      mintError: null,
      capturePayload: { raw: true },
      createdBy: null,
    });
    expect(id).toBe("1061");
    const ins = db.matching(/INSERT INTO crm_leads/)[0]!;
    expect(ins.text).toContain("nextval(pg_get_serial_sequence('crm_leads', 'id'))");
    expect(ins.text).toContain("'L-' || n.id::text");
    expect(ins.params[2]).toBe("FT");
    expect(ins.params[13]).toBe('{"raw":true}');
  });
});

describe("buildLeadSet", () => {
  it("maps camelCase to columns, skips undefined, refuses unknown keys, never interpolates values", () => {
    const { set, params } = buildLeadSet({
      mintStatus: "minted",
      bmiProjectId: "63000000009561437",
      notes: undefined,
      assignedAt: new Date("2026-09-12T23:30:00Z"),
    });
    expect(set).toBe("mint_status = $1, bmi_project_id = $2, assigned_at = $3, updated_at = NOW()");
    expect(params).toEqual(["minted", "63000000009561437", "2026-09-12T23:30:00.000Z"]);
    expect(() => buildLeadSet({ ["public_id" as "notes"]: "x" })).toThrow(/cannot patch/);
    expect(() => buildLeadSet({})).toThrow(/empty patch/);
  });
});

describe("cursor", () => {
  it("round-trips and rejects garbage", () => {
    const c = encodeCursor("2026-09-12T23:22:00.000Z", "1061");
    expect(decodeCursor(c)).toEqual({ createdAt: "2026-09-12T23:22:00.000Z", id: "1061" });
    expect(decodeCursor("not-base64!!")).toBeNull();
    expect(decodeCursor(Buffer.from("x|abc").toString("base64url"))).toBeNull();
    expect(decodeCursor(null)).toBeNull();
  });
  it("leadNumericId accepts L-123 and 123", () => {
    expect(leadNumericId("L-1061")).toBe("1061");
    expect(leadNumericId("1061")).toBe("1061");
    expect(leadNumericId("L-")).toBeNull();
    expect(leadNumericId("abc")).toBeNull();
  });
});

describe("listLeads", () => {
  it("keyset on (created_at, id), limit clamped to 200 (+1 to know there is more), no OFFSET", async () => {
    db.respond = () => [];
    await listLeads({
      limit: 5000,
      cursor: encodeCursor("2026-09-12T23:22:00.000Z", "1061"),
      statusId: "new",
      q: "gulf 2395552710",
    });
    const s = db.matching(/SELECT .* FROM crm_leads/)[0]!;
    expect(s.text).not.toMatch(/OFFSET/i);
    expect(s.text).toContain("(l.created_at, l.id) <");
    expect(s.text).toContain("ORDER BY l.created_at DESC, l.id DESC");
    expect(s.params[s.params.length - 1]).toBe(201);
    expect(s.params).toContain("new");
    expect(s.params).toContain("%gulf 2395552710%");
    expect(s.params).toContain("%2395552710%");
  });
  it("returns nextCursor only when a 51st row exists (default limit 50)", async () => {
    db.respond = () =>
      Array.from({ length: 51 }, (_, i) => ({
        ...RAW,
        id: String(100 - i),
        public_id: `L-${100 - i}`,
      }));
    const page = await listLeads();
    expect(page.leads).toHaveLength(50);
    expect(decodeCursor(page.nextCursor)).toEqual({ createdAt: RAW.created_at, id: "51" });
  });
});

describe("mapLeadRow", () => {
  it("keeps 17-digit ids and dates as strings, joins the guest and kids", () => {
    const l = mapLeadRow(RAW);
    expect(l.bmi.projectId).toBe("63000000009561437");
    expect(l.bmi.personId).toBe("63000000009561438");
    expect(l.eventDate).toBe("2026-10-16");
    expect(l.eventTime).toBe("17:30");
    expect(l.guest).toEqual({
      first: "Marcus",
      last: "Bellamy",
      phone: "+12395552710",
      email: "marcus@example.com",
      company: "Gulf Coast Logistics",
      prefers: "text",
    });
    expect(l.kids).toBe(false);
    expect(l.nextAction).toBeNull();
    expect(l.valueCents).toBe(0);
  });
});

describe("volumeByRepMonth", () => {
  it("groups open leads by assignee and party month for the given months", async () => {
    db.respond = () => [{ rep_id: "1", month: "2026-10", guests: 114, count: 3 }];
    const rows = await volumeByRepMonth(["2026-10", "2026-11"]);
    expect(rows).toEqual([{ repId: "1", month: "2026-10", guests: 114, count: 3 }]);
    const s = db.matching(/GROUP BY/)[0]!;
    expect(s.text).toContain("s.kind = 'open'");
    expect(s.params).toEqual([["2026-10", "2026-11"]]);
    expect(await volumeByRepMonth([])).toEqual([]);
  });
});
