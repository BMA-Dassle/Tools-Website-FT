import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MirrorRow } from "../service/projection";

/**
 * `crm_bmi_projects` at the SQL boundary (recording stub): the idempotent
 * upsert with its `inserted` flag and COALESCEd links, the keyset readers with
 * `limit ≤ 200`, the last-year predicate, and the sync-run ledger.
 */

const db = await vi.hoisted(async () =>
  (await import("@/test/stubs/recording-sql")).makeRecordingSql(),
);
vi.mock("@ft/db", () => ({ sql: () => db.q, isDbConfigured: () => true }));

const mod = await import("./projects-mirror-db");

const ROW: MirrorRow = {
  projectId: "58454076",
  clientKey: "headpinzftmyers",
  locationId: 332160,
  number: "H3248",
  name: "Acme Corp holiday party",
  stateId: "49130082",
  stateName: "Send Contract",
  kindId: "-1",
  responsibleUserId: "28267036",
  responsibleName: "Kelsea Kosco",
  eventDate: "2026-12-12",
  eventStart: "2026-12-12T23:00:00.000Z",
  persons: 42,
  totalValueCents: 119_997,
  balanceCents: 0,
  personId: "63000000009561437",
  personName: "Dana Acme",
  personPhone: "+12395554021",
  personEmail: "Dana@AcmeCorp.com",
  products: [
    {
      id: "91000101",
      productId: "14838862",
      name: null,
      quantity: 3,
      priceCents: 39_999,
      totalCents: 119_997,
    },
  ],
  raw: { id: "58454076", personId: "63000000009561437" },
  source: "backfill",
  bmiCreatedAt: "2026-08-30T18:02:11.000Z",
  bmiUpdatedAt: null,
};

beforeEach(() => db.reset());

describe("upsertMirrorRow", () => {
  it("INSERT … ON CONFLICT (project_id) DO UPDATE, reports inserted via xmax, ids as text params", async () => {
    db.respond = (s) => (/^INSERT INTO crm_bmi_projects/.test(s.text) ? [{ inserted: true }] : []);
    const r = await mod.upsertMirrorRow(ROW, { accountId: "12", contactId: "34" });
    expect(r).toEqual({ inserted: true });
    const ins = db.matching(/^INSERT INTO crm_bmi_projects/)[0]!;
    expect(ins.text).toContain("ON CONFLICT (project_id) DO UPDATE SET");
    expect(ins.text).toContain("RETURNING (xmax = 0) AS inserted");
    expect(ins.text).toContain(
      "account_id = COALESCE(EXCLUDED.account_id, crm_bmi_projects.account_id)",
    );
    expect(ins.text).toContain(
      "person_phone = COALESCE(EXCLUDED.person_phone, crm_bmi_projects.person_phone)",
    );
    expect(ins.text).toContain("source = EXCLUDED.source");
    expect(ins.params[0]).toBe("58454076");
    expect(ins.params[15]).toBe("63000000009561437"); // person_id, a string, never a Number
    expect(typeof ins.params[19]).toBe("string"); // products as JSON text
    expect(ins.params[19]).toContain('"productId":"14838862"');
    expect(ins.params[24]).toBe("12");
    expect(ins.params[25]).toBe("34");
  });

  it("a second upsert answers inserted:false", async () => {
    db.respond = () => [{ inserted: false }];
    expect(await mod.upsertMirrorRow(ROW)).toEqual({ inserted: false });
  });
});

describe("upsertMirrorRowsBulk", () => {
  it("one UNNEST statement per 500 rows, same ON CONFLICT rules, counts inserted", async () => {
    db.respond = (s) =>
      /SELECT \* FROM UNNEST/.test(s.text)
        ? (s.params[0] as string[]).map((_, i) => ({ inserted: i % 2 === 0 }))
        : [];
    const rows = Array.from({ length: 1001 }, (_, i) => ({
      ...ROW,
      projectId: String(i),
      kindId: "-10",
    }));
    const r = await mod.upsertMirrorRowsBulk(rows);
    expect(r).toEqual({ written: 1001, inserted: 501 });
    const stmts = db.matching(/SELECT \* FROM UNNEST/);
    expect(stmts).toHaveLength(3);
    expect((stmts[0]!.params[0] as string[]).length).toBe(500);
    expect((stmts[2]!.params[0] as string[]).length).toBe(1);
    expect(stmts[0]!.text).toContain("ON CONFLICT (project_id) DO UPDATE SET");
    expect(stmts[0]!.text).toContain("RETURNING (xmax = 0) AS inserted");
    expect(stmts[0]!.text).toContain(
      "person_name = COALESCE(EXCLUDED.person_name, crm_bmi_projects.person_name)",
    );
    expect(stmts[0]!.text).not.toContain("products"); // a stub never overwrites a fuller row's products / raw / links
    expect(stmts[0]!.params[7]).toEqual(Array(500).fill("-10"));
    // One UNNEST array per column, `synced_at` included — no implicit
    // cross-join supplying a column the parameter list does not name.
    expect(stmts[0]!.params).toHaveLength(19);
    expect(stmts[0]!.text).toContain("$19::timestamptz[]");
    expect(stmts[0]!.text).toContain("bmi_created_at, bmi_updated_at, synced_at)");
    const stamps = stmts[0]!.params[18] as string[];
    expect(stamps).toHaveLength(500);
    expect(new Set(stamps).size).toBe(1);
    expect(Number.isNaN(Date.parse(stamps[0]!))).toBe(false);
    expect(await mod.upsertMirrorRowsBulk([])).toEqual({ inserted: 0, written: 0 });
  });

  it("getMirrorKinds maps known ids to their kind", async () => {
    db.respond = () => [
      { project_id: "1", kind_id: "-10" },
      { project_id: "2", kind_id: null },
    ];
    const kinds = await mod.getMirrorKinds(["1", "2", "3"]);
    expect([...kinds]).toEqual([
      ["1", "-10"],
      ["2", null],
    ]);
    expect(db.matching(/WHERE project_id = ANY\(\$1::text\[\]\)/)[0]!.params).toEqual([
      ["1", "2", "3"],
    ]);
    expect(await mod.getMirrorKinds([])).toEqual(new Map());
  });
});

describe("readers", () => {
  const RAW = {
    project_id: "58454076",
    client_key: "headpinzftmyers",
    location_id: 332160,
    number: "H3248",
    name: "Acme",
    state_id: "49130082",
    state_name: "Send Contract",
    kind_id: "-1",
    responsible_user_id: "28267036",
    responsible_name: "Kelsea Kosco",
    event_date: "2026-12-12",
    event_start: "2026-12-12 23:00:00+00",
    persons: 42,
    total_value_cents: "119997",
    balance_cents: null,
    person_id: "63000000009561437",
    person_name: "Dana Acme",
    person_phone: "+12395554021",
    person_email: "dana@acmecorp.com",
    products: null,
    source: "backfill",
    bmi_created_at: null,
    bmi_updated_at: null,
    synced_at: "2026-09-12 23:00:00+00",
    account_id: "12",
    contact_id: null,
  };

  it("mapMirrorRow: bigints as numbers, ids as strings, unknown source falls back", () => {
    const m = mod.mapMirrorRow({ ...RAW, source: "weird" });
    expect(m.totalValueCents).toBe(119_997);
    expect(m.balanceCents).toBeNull();
    expect(m.accountId).toBe("12");
    expect(m.contactId).toBeNull();
    expect(m.personId).toBe("63000000009561437");
    expect(m.source).toBe("backfill");
    expect(m.eventDate).toBe("2026-12-12");
  });

  it("searchMirrorProjects: ILIKE on name/host/ref/account, phone digits, hides -10, keyset, limit+1", async () => {
    db.respond = () => [];
    await mod.searchMirrorProjects("Acme (239) 555", { limit: 500 });
    const s = db.matching(/FROM crm_bmi_projects p/)[0]!;
    expect(s.text).toContain("p.kind_id IS DISTINCT FROM '-10'");
    expect(s.text).toContain("LEFT JOIN crm_accounts a ON a.id = p.account_id");
    expect(s.text).toContain("a.name ILIKE $1");
    expect(s.text).toContain("p.person_phone LIKE '%' || $2 || '%'");
    expect(s.params[0]).toBe("%Acme (239) 555%");
    expect(s.params[1]).toBe("239555");
    expect(s.params[4]).toBe(201); // limit clamped to 200, +1 to detect a next page
    expect(s.params[2]).toBeNull();
  });

  it("phoneDigitsOf needs at least four digits", () => {
    expect(mod.phoneDigitsOf("Lee Health")).toBe("");
    expect(mod.phoneDigitsOf("555-40")).toBe("55540");
    expect(mod.phoneDigitsOf("12")).toBe("");
  });

  it("a full page yields a cursor that decodes to the last row's (event_date, project_id)", async () => {
    db.respond = () => [
      RAW,
      { ...RAW, project_id: "2", event_date: "2026-11-01" },
      { ...RAW, project_id: "3" },
    ];
    const page = await mod.searchMirrorProjects("acme", { limit: 2 });
    expect(page.items.map((i) => i.projectId)).toEqual(["58454076", "2"]);
    expect(page.nextCursor).not.toBeNull();
    expect(mod.decodeCursor(page.nextCursor)).toEqual({ eventDate: "2026-11-01", projectId: "2" });

    db.reset();
    db.respond = () => [];
    await mod.searchMirrorProjects("acme", { limit: 2, cursor: page.nextCursor });
    const s = db.matching(/FROM crm_bmi_projects p/)[0]!;
    expect(s.params[2]).toBe("2026-11-01");
    expect(s.params[3]).toBe("2");
    expect(s.text).toContain(
      "(COALESCE(p.event_date, '0001-01-01'::date), p.project_id) < ($3::date, $4::text)",
    );
  });

  it("decodeCursor tolerates garbage", () => {
    expect(mod.decodeCursor("not-base64!!")).toBeNull();
    expect(mod.decodeCursor(null)).toBeNull();
    expect(mod.decodeCursor(mod.encodeCursor({ eventDate: null, projectId: "9" }))).toEqual({
      eventDate: "0001-01-01",
      projectId: "9",
    });
  });

  it("listLastYearHosts: the window, no cancellations, no later project, no later lead by account/phone/email", async () => {
    db.respond = () => [];
    await mod.listLastYearHosts({
      from: "2025-10-03",
      till: "2025-11-07",
      clientKey: "headpinznaples",
      limit: 10,
    });
    const s = db.matching(/FROM crm_bmi_projects p/)[0]!;
    expect(s.text).toContain("p.event_date BETWEEN $1::date AND $2::date");
    expect(s.text).toContain("p.state_id IS DISTINCT FROM '-4'");
    expect(s.text).toContain("n.event_date > p.event_date");
    // "Come back" means come back THIS year: a booking a fortnight after last
    // year's event must not hide the host from the reach-out list.
    expect(s.text).toContain("n.event_date >= $1::date + INTERVAL '1 year' - INTERVAL '8 weeks'");
    expect(s.text).toContain("l.event_date >= $1::date + INTERVAL '1 year' - INTERVAL '8 weeks'");
    expect(s.text).toContain("FROM crm_leads l");
    expect(s.text).toContain("LEFT JOIN crm_contacts c ON c.id = l.contact_id");
    expect(s.text).toContain("l.archived_at IS NULL");
    expect(s.text).toContain("c.phone_e164 = p.person_phone");
    expect(s.text).toContain("c.email_key = lower(p.person_email)");
    expect(s.text).toContain("ORDER BY p.event_date ASC, p.project_id ASC");
    expect(s.params.slice(0, 3)).toEqual(["2025-10-03", "2025-11-07", "headpinznaples"]);
    expect(s.params[5]).toBe(11);
  });

  it("listMirrorProjectsForAccount is keyset by (event_date DESC, project_id DESC)", async () => {
    db.respond = () => [];
    await mod.listMirrorProjectsForAccount("12", { limit: 5 });
    const s = db.matching(/WHERE p.account_id = \$1::bigint/)[0]!;
    expect(s.text).toContain(
      "ORDER BY COALESCE(p.event_date, '0001-01-01'::date) DESC, p.project_id DESC",
    );
    expect(s.params).toEqual(["12", null, "", 6]);
  });

  it("countMirrorProjects splits online bookings out", async () => {
    db.respond = () => [{ total: 10, group_events: 7 }];
    expect(await mod.countMirrorProjects({ clientKey: "headpinznaples" })).toEqual({
      total: 10,
      groupEvents: 7,
    });
    const s = db.matching(/count\(\*\) FILTER/)[0]!;
    expect(s.text).toContain("kind_id IS DISTINCT FROM '-10'");
    expect(s.params).toEqual(["headpinznaples", null, null]);
  });
});

describe("the sync-run ledger", () => {
  it("startRun opens ok=false; finishRun closes with counts; lastOkRun asks for ok + finished, newest window first", async () => {
    db.respond = (s) => (/^INSERT INTO crm_bmi_sync_runs/.test(s.text) ? [{ id: "5" }] : []);
    const id = await mod.startSyncRun({
      clientKey: "headpinznaples",
      kind: "backfill",
      windowFrom: "2025-09-01T04:00:00.000Z",
      windowUntil: "2025-10-01T04:00:00.000Z",
    });
    expect(id).toBe("5");
    expect(db.matching(/INSERT INTO crm_bmi_sync_runs/)[0]!.text).toContain("ok)");
    expect(db.matching(/INSERT INTO crm_bmi_sync_runs/)[0]!.text).toContain("false)");

    db.reset();
    db.respond = () => [];
    await mod.finishSyncRun("5", { rowsSeen: 2, rowsUpserted: 2, ok: true, error: null });
    const fin = db.matching(/UPDATE crm_bmi_sync_runs/)[0]!;
    expect(fin.text).toContain("finished_at = NOW()");
    expect(fin.params).toEqual(["5", 2, 2, true, null]);

    db.reset();
    await mod.lastOkSyncRun("headpinznaples", "delta");
    const last = db.matching(/FROM crm_bmi_sync_runs/)[0]!;
    expect(last.text).toContain("ok = true AND finished_at IS NOT NULL");
    expect(last.text).toContain("ORDER BY window_until DESC NULLS LAST, id DESC");
    expect(last.params).toEqual(["headpinznaples", "delta"]);
  });
});
