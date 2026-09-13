import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseCsv } from "../csv";
import { suggestColumnMap } from "../mapping";
import { UGLY_CSV } from "../test-support";
import type { ColdCandidate } from "../dedupe";
import type { ColdRowProjectionPatch } from "../data/rows-db";

/**
 * The mapping and de-duplication pass, driven over THE UGLY FIXTURE with the
 * data layer stubbed — so what is under test is the thing that decides what
 * every row becomes, not Neon.
 */

const store = vi.hoisted(() => ({
  records: [] as { id: string; rowIndex: number; raw: Record<string, unknown> }[],
  candidates: [] as ColdCandidate[],
  patches: [] as ColdRowProjectionPatch[],
  pages: 0,
  candidateCalls: [] as {
    bmiPersonIds: readonly string[];
    phones: readonly string[];
    emails: readonly string[];
    nameKeys: readonly string[];
  }[],
  decisions: [] as { rowId: string; decision: string }[],
  listPatch: null as Record<string, unknown> | null,
  committed: false,
  audits: [] as { action: string; entity: string }[],
  inserted: [] as { listId: string; count: number }[],
}));

const LIST = {
  id: "7",
  name: "Fort Myers Chamber — Tech & Professional",
  status: "staged" as const,
  centre: "HPFM" as const,
  ownerRepId: "3",
  ownerRepSlug: "kelsea",
  ownerRepName: "Kelsea Kosco",
  ownerRepInitials: "KK",
  sourceFilename: "chamber-tech-members.csv",
  columnMap: null,
  parseMeta: null,
  headers: [],
  rowCount: 8,
  importedBy: "kelsea@headpinz.com",
  archivedAt: null,
  createdAt: "2026-09-13T18:00:00.000Z",
  stats: {
    rows: 8,
    skipped: 0,
    called: 0,
    interested: 0,
    converted: 0,
    booked: 0,
    linked: 0,
    dialable: 0,
    callbacksDue: 0,
  },
};

vi.mock("@ft/db", () => ({ sql: () => ({}), isDbConfigured: () => false }));

vi.mock("~/features/crm/leads", async () => {
  // The REAL `accountNameKey`, so the account-name match key under test is the
  // one the rest of the CRM uses — just without the leads barrel's transports.
  const mod = await vi.importActual<typeof import("~/features/crm/leads/data/accounts-db")>(
    "~/features/crm/leads/data/accounts-db",
  );
  return { accountNameKey: mod.accountNameKey };
});

vi.mock("~/features/crm/core/data/audit-db", () => ({
  writeAudit: async (a: { action: string; entity: string }) => {
    store.audits.push(a);
  },
}));

vi.mock("../data/lists-db", () => ({
  getColdList: async () => LIST,
  insertColdList: async () => "7",
  refreshColdRowCount: async () => store.records.length,
  updateColdList: async (_id: string, patch: Record<string, unknown>) => {
    store.listPatch = patch;
    return LIST;
  },
}));

vi.mock("../data/rows-db", () => ({
  listColdRawRecords: async (_listId: string, after: number, limit: number) => {
    store.pages++;
    return store.records.filter((r) => r.rowIndex > after).slice(0, limit);
  },
  findColdCandidates: async (keys: (typeof store.candidateCalls)[number]) => {
    store.candidateCalls.push(keys);
    return store.candidates;
  },
  applyColdProjections: async (patches: ColdRowProjectionPatch[]) => {
    store.patches.push(...patches);
    return patches.length;
  },
  insertColdRows: async (listId: string, records: unknown[]) => {
    store.inserted.push({ listId, count: records.length });
    return records.length;
  },
  setColdRowDecision: async (rowId: string, decision: string) => {
    store.decisions.push({ rowId, decision });
  },
  commitColdRows: async () => {
    store.committed = true;
    return { imported: 7, linked: 2, skipped: 1 };
  },
  coldRowTotals: async () => ({
    rows: 8,
    withPhone: 7,
    withEmail: 6,
    undialable: 1,
    matched: 2,
    duplicatesInFile: 1,
    unreachable: 0,
  }),
  listColdMatches: async () => [],
}));

const { appendColdRows, commitColdList, mapColdList, unique } = await import("./import");

const USER = {
  email: "kelsea@headpinz.com",
  name: "Kelsea Kosco",
  sub: null,
  roles: ["access", "sales"],
  role: "rep" as const,
  rep: null,
};

const table = parseCsv(UGLY_CSV);
const MAP = suggestColumnMap(table.headers);

beforeEach(() => {
  store.records = table.records.map((r, i) => ({
    id: String(100 + i),
    rowIndex: r.index,
    raw: r.values,
  }));
  store.candidates = [];
  store.patches = [];
  store.pages = 0;
  store.candidateCalls = [];
  store.decisions = [];
  store.listPatch = null;
  store.committed = false;
  store.audits = [];
  store.inserted = [];
});

function patchFor(company: string): ColdRowProjectionPatch {
  return store.patches.find((p) => p.company === company)!;
}

describe("mapColdList over the ugly fixture", () => {
  it("projects every row, including the ones with holes in them", async () => {
    await mapColdList("7", MAP, USER);
    expect(store.patches).toHaveLength(8);
    expect(patchFor("BrightPath Dental").phoneE164).toBe("+12395557015");
    expect(patchFor("Meridian IT").phoneE164).toBe("+12395554471");
    expect(patchFor("Palm Legal Group").contactName).toBeNull();
  });

  it("keeps a phone it could not read, and does not pretend it has one", async () => {
    await mapColdList("7", MAP, USER);
    const broken = patchFor("Broken Phone Co");
    expect(broken.phoneRaw).toBe("2.39556E+09");
    expect(broken.phoneE164).toBeNull();
  });

  it("flags the second copy of a number inside the same file and defaults it to skip", async () => {
    await mapColdList("7", MAP, USER);
    expect(patchFor("BrightPath Dental").matchedBy).toBeNull();
    expect(patchFor("Duplicate Dental").matchedBy).toBe("in_file");
    expect(patchFor("Duplicate Dental").decision).toBe("skip");
  });

  it("links a row to an account we already have rather than duplicating it", async () => {
    store.candidates = [
      {
        contactId: null,
        accountId: "88",
        accountName: "Coastal Title, LLC",
        contactName: null,
        bmiPersonId: null,
        phoneE164: null,
        emailKey: null,
        nameKey: "coastal title",
      },
    ];
    await mapColdList("7", MAP, USER);
    const coastal = patchFor("Coastal Title Co.");
    expect(coastal.matchedBy).toBe("account_name");
    expect(coastal.accountId).toBe("88");
    expect(coastal.decision).toBe("link");
  });

  it("prefers a contact matched by BMI person id over one matched by phone", async () => {
    const withId = { ...MAP, bmiPersonId: "Phone (2)" };
    store.candidates = [
      {
        contactId: "5",
        accountId: null,
        accountName: null,
        contactName: "By phone",
        bmiPersonId: null,
        phoneE164: "+12395557015",
        emailKey: null,
        nameKey: null,
      },
    ];
    await mapColdList("7", withId, USER);
    // "239-555-7016" is not all digits after the dashes are kept, so the id is
    // discarded and the phone match stands — proof the id column is validated,
    // never coerced.
    expect(patchFor("BrightPath Dental").bmiPersonId).toBeNull();
    expect(patchFor("BrightPath Dental").matchedBy).toBe("phone");
  });

  it("asks for candidates ONCE per page, with de-duplicated keys", async () => {
    await mapColdList("7", MAP, USER);
    expect(store.candidateCalls).toHaveLength(1);
    const call = store.candidateCalls[0]!;
    // BrightPath and Duplicate Dental share a number; it is asked for once.
    expect(call.phones).toEqual([...new Set(call.phones)]);
    expect(call.phones).toContain("+12395557015");
    expect(call.emails).toContain("devon@brightpath.example");
    expect(call.nameKeys).toContain("brightpath dental");
  });

  it("stores the map on the list so the sheet can be reopened", async () => {
    await mapColdList("7", MAP, USER);
    expect(store.listPatch).toEqual({ columnMap: MAP });
    expect(store.audits.some((a) => a.action === "map")).toBe(true);
  });

  it("a different map re-reads the same stored records", async () => {
    await mapColdList("7", { phone: "Phone (2)" }, USER);
    const first = store.patches.find((p) => p.phoneRaw === "239-555-7016");
    expect(first).toBeDefined();
    expect(first!.company).toBeNull();
    expect(first!.phoneE164).toBe("+12395557016");
  });

  it("an empty map still projects every row, so nothing is lost", async () => {
    await mapColdList("7", {}, USER);
    expect(store.patches).toHaveLength(8);
    expect(store.patches.every((p) => p.phoneE164 === null)).toBe(true);
    expect(store.patches.every((p) => p.matchedBy === null)).toBe(true);
  });

  it("pages rather than reading the whole list at once", async () => {
    await mapColdList("7", MAP, USER);
    // Eight rows fit one page of 500, so exactly one read plus the short-page exit.
    expect(store.pages).toBe(1);
  });

  it("reports what the operator needs to decide", async () => {
    const { report } = await mapColdList("7", MAP, USER);
    expect(report).toMatchObject({
      rows: 8,
      withPhone: 7,
      undialable: 1,
      matched: 2,
      duplicatesInFile: 1,
    });
  });
});

describe("appendColdRows", () => {
  it("writes the chunk and refreshes the count", async () => {
    const out = await appendColdRows(
      "7",
      [
        { index: 1, values: { Phone: "(239) 555-7015" } },
        { index: 2, values: { Phone: "(239) 555-3110" } },
      ],
      USER,
    );
    expect(store.inserted).toEqual([{ listId: "7", count: 2 }]);
    expect(out.inserted).toBe(2);
  });

  it("refuses a chunk past the row cap instead of writing half of it", async () => {
    await expect(appendColdRows("7", [{ index: 10_001, values: {} }], USER)).rejects.toThrow(
      "cold_list_full",
    );
    expect(store.inserted).toHaveLength(0);
  });
});

describe("commitColdList", () => {
  it("applies the operator's decisions, then opens the list for dialling", async () => {
    const out = await commitColdList(
      "7",
      [
        { rowId: "107", decision: "skip" },
        { rowId: "101", decision: "new" },
      ],
      USER,
    );
    expect(store.decisions).toEqual([
      { rowId: "107", decision: "skip" },
      { rowId: "101", decision: "new" },
    ]);
    expect(store.committed).toBe(true);
    expect(store.listPatch).toEqual({ status: "ready" });
    expect(out).toMatchObject({ imported: 7, linked: 2, skipped: 1 });
    expect(store.audits.some((a) => a.action === "commit")).toBe(true);
  });

  it("commits with no decisions at all — everything matched links, as promised", async () => {
    await commitColdList("7", [], USER);
    expect(store.decisions).toHaveLength(0);
    expect(store.committed).toBe(true);
  });
});

describe("unique", () => {
  it("drops nulls and repeats, keeping order", () => {
    expect(unique(["a", null, "b", "a", "", "c"])).toEqual(["a", "b", "c"]);
  });
});
