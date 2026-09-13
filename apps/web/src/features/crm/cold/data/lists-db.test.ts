import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The lists data layer at the SQL boundary: the PER-LIST CONVERSION COUNTERS
 * (what the lists screen and the detail tiles read) and the row mapping.
 */

const db = await vi.hoisted(async () =>
  (await import("@/test/stubs/recording-sql")).makeRecordingSql(),
);

vi.mock("@ft/db", () => ({ sql: () => db.q, isDbConfigured: () => true }));
vi.mock("~/features/crm/reps", () => ({ ensureRepsSchema: async () => {} }));

const { coldListStats, insertColdList, listColdLists, mapColdListRow, updateColdList } =
  await import("./lists-db");

const EMPTY = {
  rows: 0,
  skipped: 0,
  called: 0,
  interested: 0,
  converted: 0,
  booked: 0,
  linked: 0,
  dialable: 0,
  callbacksDue: 0,
};

beforeEach(() => {
  db.reset();
  db.respond = () => [];
});

describe("mapColdListRow", () => {
  const raw = {
    id: "7",
    name: "Fort Myers Chamber — Tech & Professional",
    status: "ready",
    centre: "HPFM",
    owner_rep_id: "3",
    source_filename: "chamber-tech-members.csv",
    column_map: { company: "Business Name", phone: "Phone" },
    parse_meta: {
      delimiter: ",",
      hadBom: true,
      hasHeaderRow: true,
      blankRows: 1,
      raggedRows: 1,
      bytes: 900,
    },
    headers: ["Business Name", "Phone"],
    row_count: "120",
    imported_by: "kelsea@headpinz.com",
    archived_at: null,
    created_at: "2026-08-28T12:00:00.000Z",
    owner_slug: "kelsea",
    owner_name: "Kelsea Kosco",
    owner_initials: "KK",
  };

  it("keeps ids as strings and reads the JSONB columns back", () => {
    const list = mapColdListRow(raw, EMPTY);
    expect(list.id).toBe("7");
    expect(list.ownerRepId).toBe("3");
    expect(list.rowCount).toBe(120);
    expect(list.columnMap).toEqual({ company: "Business Name", phone: "Phone" });
    expect(list.headers).toEqual(["Business Name", "Phone"]);
    expect(list.parseMeta?.hadBom).toBe(true);
  });

  it("falls back to 'ready' for a status it does not recognise, and to [] for bad JSONB", () => {
    expect(mapColdListRow({ ...raw, status: "whatever" }, EMPTY).status).toBe("ready");
    expect(mapColdListRow({ ...raw, headers: "not an array" }, EMPTY).headers).toEqual([]);
    expect(mapColdListRow({ ...raw, column_map: [] }, EMPTY).columnMap).toBeNull();
  });
});

describe("coldListStats — the per-list conversion counters", () => {
  it("counts every list in ONE query, keyed by list id", async () => {
    db.respond = () => [
      {
        list_id: "7",
        rows: 113,
        skipped: 7,
        called: 34,
        interested: 6,
        converted: 4,
        booked: 1,
        linked: 7,
        dialable: 110,
        callbacks_due: 2,
      },
    ];
    const stats = await coldListStats(["7", "8"]);
    expect(db.matching(/FROM crm_cold_rows cr/)).toHaveLength(1);
    expect(stats.get("7")).toEqual({
      rows: 113,
      skipped: 7,
      called: 34,
      interested: 6,
      converted: 4,
      booked: 1,
      linked: 7,
      dialable: 110,
      callbacksDue: 2,
    });
    // A list with no rows simply is not in the map; the reader defaults it.
    expect(stats.get("8")).toBeUndefined();
  });

  it("counts 'booked' through the status KIND, never a hard-coded status id", async () => {
    db.respond = () => [];
    await coldListStats(["7"]);
    const text = db.matching(/FROM crm_cold_rows cr/)[0]!.text;
    expect(text).toContain("LEFT JOIN crm_statuses s ON s.id = l.status_id");
    expect(text).toContain("s.kind = 'won'");
    expect(text).not.toMatch(/status_id = 'confirmed'/);
  });

  it("leaves skipped rows out of every counter", async () => {
    db.respond = () => [];
    await coldListStats(["7"]);
    const text = db.matching(/FROM crm_cold_rows cr/)[0]!.text;
    const counters = text.match(/count\(\*\) FILTER \(WHERE [^)]*\)/g) ?? [];
    // Every counter but the `skipped` one excludes skipped rows.
    const nonSkip = counters.filter((c) => !c.includes("cr.status = 'skipped'"));
    expect(nonSkip.length).toBeGreaterThan(0);
    expect(nonSkip.every((c) => c.includes("cr.status <> 'skipped'"))).toBe(true);
  });

  it("does nothing for an empty list of ids", async () => {
    expect((await coldListStats([])).size).toBe(0);
    expect(db.statements).toHaveLength(0);
  });
});

describe("listColdLists", () => {
  it("hides archived lists unless asked", async () => {
    db.respond = () => [];
    await listColdLists();
    expect(db.matching(/FROM crm_cold_lists cl/)[0]!.text).toContain("cl.archived_at IS NULL");
    db.reset();
    db.respond = () => [];
    await listColdLists({ includeArchived: true });
    expect(db.matching(/FROM crm_cold_lists cl/)[0]!.text).not.toContain("archived_at IS NULL");
  });
});

describe("insertColdList", () => {
  it("starts the list STAGED with no rows — the rows follow, and are persisted first", async () => {
    db.respond = () => [{ id: "7" }];
    const id = await insertColdList({
      name: "Chamber",
      ownerRepId: "3",
      centre: "HPFM",
      sourceFilename: "chamber.csv",
      headers: ["A", "B"],
      parseMeta: null,
      columnMap: null,
      importedBy: "kelsea@headpinz.com",
    });
    expect(id).toBe("7");
    const stmt = db.matching(/INSERT INTO crm_cold_lists/)[0]!;
    expect(stmt.text).toContain("'staged', 0");
    expect(stmt.params[4]).toBe(JSON.stringify(["A", "B"]));
  });
});

describe("updateColdList", () => {
  it("only writes the fields it was given", async () => {
    db.respond = () => [];
    await updateColdList("7", { name: "Renamed" });
    const stmt = db.matching(/UPDATE crm_cold_lists SET/)[0]!;
    expect(stmt.text).toContain("name = $2");
    expect(stmt.text).not.toContain("owner_rep_id");
    expect(stmt.text).not.toContain("status =");
  });

  it("archives and restores without deleting anything", async () => {
    db.respond = () => [];
    await updateColdList("7", { archived: true });
    expect(db.matching(/UPDATE crm_cold_lists SET/)[0]!.text).toContain("archived_at = NOW()");
    db.reset();
    db.respond = () => [];
    await updateColdList("7", { archived: false });
    expect(db.matching(/UPDATE crm_cold_lists SET/)[0]!.text).toContain("archived_at = NULL");
    expect(db.matching(/DELETE FROM/)).toHaveLength(0);
  });
});

describe("the DDL", () => {
  it("adds C8's columns to PR1's table rather than creating a second one", async () => {
    vi.resetModules();
    db.reset();
    db.respond = () => [];
    const { ensureColdListsSchema } = await import("./lists-db");
    await ensureColdListsSchema();
    expect(db.matching(/CREATE TABLE IF NOT EXISTS crm_cold_lists/)).toHaveLength(1);
    const alters = db.matching(/ALTER TABLE crm_cold_lists/).map((s) => s.text);
    expect(alters.length).toBeGreaterThan(0);
    expect(alters.every((t) => t.includes("ADD COLUMN IF NOT EXISTS"))).toBe(true);
  });
});
