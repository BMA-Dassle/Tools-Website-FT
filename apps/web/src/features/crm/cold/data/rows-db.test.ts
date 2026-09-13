import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The cold rows data layer at the SQL boundary (brief §3.10): a recording
 * tagged-template stub instead of Neon, so the statements themselves are the
 * thing under test — the idempotent chunk insert, the keyset page, the bulk
 * projection write and the atomic touch counter.
 */

const db = await vi.hoisted(async () =>
  (await import("@/test/stubs/recording-sql")).makeRecordingSql(),
);

vi.mock("@ft/db", () => ({
  sql: () => db.q,
  isDbConfigured: () => true,
}));

const {
  applyColdProjections,
  commitColdRows,
  decodeColdCursor,
  encodeColdCursor,
  findColdCandidates,
  insertColdRows,
  listColdRows,
  mapColdRow,
  nextColdRow,
  setColdRowDisposition,
} = await import("./rows-db");

type ColdRowRaw =
  Awaited<ReturnType<(typeof import("./rows-db"))["getColdRow"]>> extends null
    ? never
    : Parameters<typeof mapColdRow>[0];

function raw(partial: Partial<ColdRowRaw> = {}): ColdRowRaw {
  return {
    id: "501",
    list_id: "7",
    row_index: 3,
    company: "BrightPath Dental",
    contact_name: "Devon Okafor",
    phone_e164: "+12395557015",
    phone_raw: "(239) 555-7015",
    email: "devon@brightpath.example",
    email_key: "devon@brightpath.example",
    city: "Fort Myers",
    notes: "Chamber list",
    bmi_person_id: "63000000009561437",
    account_id: "88",
    contact_id: "5",
    lead_id: "9",
    matched_by: "phone",
    decision: "link",
    status: "ready",
    disposition: "Voicemail",
    disposition_note: "left a message",
    disposition_at: "2026-09-13T18:20:00.000Z",
    disposition_by: "kelsea@headpinz.com",
    callback_at: null,
    touch_count: 2,
    created_at: "2026-09-13T18:00:00.000Z",
    account_name: "BrightPath Dental",
    lead_public_id: "L-9",
    ...partial,
  };
}

beforeEach(() => {
  db.reset();
  db.respond = () => [];
});

describe("mapColdRow", () => {
  it("keeps every id a string, the BMI person id included", () => {
    const row = mapColdRow(raw());
    expect(row.id).toBe("501");
    expect(row.listId).toBe("7");
    expect(row.accountId).toBe("88");
    expect(row.bmiPersonId).toBe("63000000009561437");
    expect(typeof row.bmiPersonId).toBe("string");
    // The negative control: as a NUMBER that id is already a different id.
    expect(String(Number(row.bmiPersonId))).not.toBe("63000000009561437");
  });

  it("normalises a decision, status and match key it does not recognise", () => {
    expect(mapColdRow(raw({ decision: "whatever" })).decision).toBe("new");
    expect(mapColdRow(raw({ status: "whatever" })).status).toBe("staged");
    expect(mapColdRow(raw({ matched_by: "whatever" })).matchedBy).toBeNull();
  });

  it("keeps the raw phone when there is no canonical one", () => {
    const row = mapColdRow(raw({ phone_e164: null, phone_raw: "2.39556E+09" }));
    expect(row.phoneE164).toBeNull();
    expect(row.phoneRaw).toBe("2.39556E+09");
  });
});

describe("the keyset cursor", () => {
  it("round-trips and refuses anything it did not write", () => {
    const c = encodeColdCursor({ rowIndex: 41, id: "900" });
    expect(decodeColdCursor(c)).toEqual({ rowIndex: 41, id: "900" });
    expect(decodeColdCursor(null)).toBeNull();
    expect(decodeColdCursor("not-a-cursor")).toBeNull();
    expect(decodeColdCursor(Buffer.from("a:b").toString("base64url"))).toBeNull();
  });
});

describe("insertColdRows", () => {
  it("writes ONLY raw, row_index and the list — no mapping, no matching", async () => {
    db.respond = () => [{ id: "1" }, { id: "2" }];
    await insertColdRows("7", [
      { index: 1, values: { Phone: "(239) 555-7015" } },
      { index: 2, values: { Phone: "(239) 555-3110" } },
    ]);
    const stmt = db.matching(/INSERT INTO crm_cold_rows/)[0]!;
    expect(stmt.text).toContain("(list_id, row_index, raw)");
    expect(stmt.text).not.toMatch(/phone_e164|account_id|matched_by/);
    expect(stmt.params[0]).toBe("7");
    expect(stmt.params[2]).toBe(JSON.stringify({ Phone: "(239) 555-7015" }));
  });

  it("is a no-op on a re-posted chunk", async () => {
    db.respond = () => [];
    const inserted = await insertColdRows("7", [{ index: 1, values: { a: "b" } }]);
    expect(db.matching(/INSERT INTO crm_cold_rows/)[0]!.text).toContain(
      "ON CONFLICT (list_id, row_index) DO NOTHING",
    );
    expect(inserted).toBe(0);
  });

  it("does nothing at all for an empty chunk", async () => {
    expect(await insertColdRows("7", [])).toBe(0);
    expect(db.matching(/INSERT INTO crm_cold_rows/)).toHaveLength(0);
  });
});

describe("applyColdProjections", () => {
  it("writes a whole page in ONE statement", async () => {
    db.respond = () => [{ id: "1" }, { id: "2" }];
    await applyColdProjections([projection("1", "+12395557015"), projection("2", "+12395553110")]);
    const updates = db.matching(/UPDATE crm_cold_rows cr/);
    expect(updates).toHaveLength(1);
    expect(updates[0]!.text).toContain("FROM (VALUES");
    expect(updates[0]!.params).toHaveLength(28);
  });

  it("never touches the disposition columns — a re-map keeps the calls made", async () => {
    db.respond = () => [{ id: "1" }];
    await applyColdProjections([projection("1", "+12395557015")]);
    const text = db.matching(/UPDATE crm_cold_rows cr/)[0]!.text;
    expect(text).not.toMatch(/SET[^;]*\bdisposition\b/);
    expect(text).not.toMatch(/touch_count/);
    expect(text).not.toMatch(/lead_id/);
  });
});

function projection(id: string, phone: string) {
  return {
    id,
    company: "X",
    contactName: "Y",
    phoneE164: phone,
    phoneRaw: phone,
    email: null,
    emailKey: null,
    city: null,
    notes: null,
    bmiPersonId: null,
    accountId: null,
    contactId: null,
    matchedBy: null,
    decision: "new" as const,
  };
}

describe("listColdRows", () => {
  it("pages by (row_index, id) and never uses OFFSET", async () => {
    db.respond = () => [];
    await listColdRows("7", { cursor: encodeColdCursor({ rowIndex: 5, id: "60" }), limit: 10 });
    const stmt = db.matching(/FROM crm_cold_rows cr/)[0]!;
    expect(stmt.text).toContain("(cr.row_index, cr.id) >");
    expect(stmt.text).not.toMatch(/OFFSET/i);
    expect(stmt.text).toContain("ORDER BY cr.row_index ASC, cr.id ASC");
  });

  it("asks for one more row than the page, to know whether there is another", async () => {
    db.respond = () => [];
    await listColdRows("7", { limit: 10 });
    expect(db.matching(/FROM crm_cold_rows cr/)[0]!.params.at(-1)).toBe(11);
  });

  it("hands back a cursor only when a further page exists", async () => {
    db.respond = () => [raw({ id: "1", row_index: 1 }), raw({ id: "2", row_index: 2 })];
    const page = await listColdRows("7", { limit: 2 });
    expect(page.rows).toHaveLength(2);
    expect(page.nextCursor).toBeNull();

    db.reset();
    db.respond = () => [
      raw({ id: "1", row_index: 1 }),
      raw({ id: "2", row_index: 2 }),
      raw({ id: "3", row_index: 3 }),
    ];
    const more = await listColdRows("7", { limit: 2 });
    expect(more.rows).toHaveLength(2);
    expect(decodeColdCursor(more.nextCursor)).toEqual({ rowIndex: 2, id: "2" });
  });

  it("filters skipped rows out of every view but the skipped one", async () => {
    db.respond = () => [];
    await listColdRows("7", { filter: "all" });
    expect(db.matching(/FROM crm_cold_rows cr/)[0]!.text).toContain("cr.status <> 'skipped'");
    db.reset();
    db.respond = () => [];
    await listColdRows("7", { filter: "skipped" });
    expect(db.matching(/FROM crm_cold_rows cr/)[0]!.text).toContain("cr.status = 'skipped'");
  });
});

describe("nextColdRow", () => {
  it("only offers a row with a number, and puts a due callback first", async () => {
    db.respond = () => [];
    await nextColdRow("7");
    const text = db.matching(/FROM crm_cold_rows cr/)[0]!.text;
    expect(text).toContain("cr.phone_e164 IS NOT NULL");
    expect(text).toContain("cr.status = 'ready'");
    expect(text).toContain("cr.callback_at <= NOW()) DESC");
  });
});

describe("setColdRowDisposition", () => {
  it("bumps touch_count in the SAME statement as the outcome", async () => {
    db.respond = (s) => (/RETURNING id::text/.test(s.text) ? [{ id: "501" }] : [raw()]);
    await setColdRowDisposition("501", {
      disposition: "Voicemail",
      note: "left a message",
      callbackAt: null,
      actorEmail: "kelsea@headpinz.com",
      at: new Date("2026-09-13T18:20:00Z"),
    });
    const stmt = db.matching(/UPDATE crm_cold_rows\s+SET disposition/)[0]!;
    expect(stmt.text).toContain("touch_count = touch_count + 1");
    expect(stmt.params[1]).toBe("Voicemail");
    expect(stmt.params[4]).toBe("kelsea@headpinz.com");
  });

  it("clears a stale callback when the new outcome does not set one", async () => {
    db.respond = (s) => (/RETURNING id::text/.test(s.text) ? [{ id: "501" }] : [raw()]);
    await setColdRowDisposition("501", {
      disposition: "Reached",
      note: null,
      callbackAt: null,
      actorEmail: "kelsea@headpinz.com",
      at: new Date("2026-09-13T18:20:00Z"),
    });
    expect(db.matching(/UPDATE crm_cold_rows\s+SET disposition/)[0]!.params[3]).toBeNull();
  });

  it("never un-skips a row a decision skipped", async () => {
    db.respond = (s) => (/RETURNING id::text/.test(s.text) ? [{ id: "501" }] : [raw()]);
    await setColdRowDisposition("501", {
      disposition: "Reached",
      note: null,
      callbackAt: null,
      actorEmail: "k@headpinz.com",
      at: new Date(),
    });
    expect(db.matching(/UPDATE crm_cold_rows\s+SET disposition/)[0]!.text).toContain(
      "CASE WHEN status = 'skipped' THEN status ELSE 'ready' END",
    );
  });
});

describe("commitColdRows", () => {
  it("skips only what the operator chose, and leaves dispositioned rows alone", async () => {
    db.respond = (s) =>
      /count\(\*\) FILTER/.test(s.text) ? [{ imported: 7, linked: 2, skipped: 1 }] : [];
    const counts = await commitColdRows("7");
    const update = db.matching(/UPDATE crm_cold_rows\s+SET status/)[0]!;
    expect(update.text).toContain("CASE WHEN decision = 'skip' THEN 'skipped' ELSE 'ready' END");
    expect(update.text).toContain("disposition IS NULL");
    expect(counts).toEqual({ imported: 7, linked: 2, skipped: 1 });
  });
});

describe("findColdCandidates", () => {
  it("asks for contacts and accounts in two queries, not one per row", async () => {
    db.respond = () => [];
    await findColdCandidates({
      bmiPersonIds: ["63000000009561437"],
      phones: ["+12395557015", "+12395553110"],
      emails: ["a@b.example"],
      nameKeys: ["brightpath dental"],
    });
    expect(db.matching(/FROM crm_contacts c/)).toHaveLength(1);
    expect(db.matching(/FROM crm_accounts a/)).toHaveLength(1);
  });

  it("does nothing when there is nothing to look up", async () => {
    await findColdCandidates({ bmiPersonIds: [], phones: [], emails: [], nameKeys: [] });
    expect(db.statements).toHaveLength(0);
  });

  it("only asks about the keys it was given", async () => {
    db.respond = () => [];
    await findColdCandidates({
      bmiPersonIds: [],
      phones: ["+12395557015"],
      emails: [],
      nameKeys: [],
    });
    const stmt = db.matching(/FROM crm_contacts c/)[0]!;
    expect(stmt.text).toContain("c.phone_e164 IN");
    expect(stmt.text).not.toContain("c.email_key IN");
    expect(stmt.text).not.toContain("c.bmi_person_id IN");
    expect(db.matching(/FROM crm_accounts a/)).toHaveLength(0);
  });
});

describe("the DDL", () => {
  it("adds C8's columns rather than editing PR1's CREATE TABLE, and keeps ids TEXT", async () => {
    // `ensureColdRowsSchema` is a module-level memo, and the tests above have
    // already resolved it — a fresh module graph is the only way to watch it
    // issue its statements (the same reason `core/schema.test.ts` resets).
    vi.resetModules();
    db.reset();
    db.respond = () => [];
    const { ensureColdRowsSchema } = await import("./rows-db");
    await ensureColdRowsSchema();
    const creates = db.matching(/CREATE TABLE IF NOT EXISTS/);
    expect(creates.filter((s) => /crm_cold_rows/.test(s.text))).toHaveLength(1);
    const alters = db.matching(/ALTER TABLE crm_cold_rows/).map((s) => s.text);
    expect(alters.every((t) => t.includes("ADD COLUMN IF NOT EXISTS"))).toBe(true);
    expect(alters.some((t) => /bmi_person_id TEXT/.test(t))).toBe(true);
    expect(alters.some((t) => /bmi_person_id BIGINT/.test(t))).toBe(false);
    expect(db.matching(/CREATE UNIQUE INDEX IF NOT EXISTS crm_cold_rows_list_index/)).toHaveLength(
      1,
    );
  });
});
