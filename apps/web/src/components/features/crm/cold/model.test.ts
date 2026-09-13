import { describe, expect, it } from "vitest";
import type { ColdImportReport, ColdListView, ColdRowView } from "~/features/crm/cold/contracts";
import { isoFromLocal } from "./ColdDispositionSheet";
import {
  callbackDue,
  canConvert,
  dispositionKind,
  firstMatchExample,
  importSummary,
  isDialable,
  listMeta,
  matchLabel,
  pct,
  reportIsEmpty,
  rowNumber,
  rowTitle,
  statsLine,
} from "./model";

function row(over: Partial<ColdRowView> = {}): ColdRowView {
  return {
    id: "501",
    listId: "7",
    rowIndex: 3,
    company: "BrightPath Dental",
    contactName: "Devon Okafor",
    phoneE164: "+12395557015",
    phoneRaw: "(239) 555-7015",
    email: "devon@brightpath.example",
    city: "Fort Myers",
    notes: null,
    bmiPersonId: null,
    accountId: null,
    accountName: null,
    contactId: null,
    leadId: null,
    leadPublicId: null,
    matchedBy: null,
    decision: "new",
    status: "ready",
    disposition: null,
    dispositionNote: null,
    dispositionAt: null,
    dispositionBy: null,
    callbackAt: null,
    touchCount: 0,
    createdAt: "2026-09-13T18:00:00.000Z",
    ...over,
  };
}

function report(over: Partial<ColdImportReport> = {}): ColdImportReport {
  return {
    rows: 113,
    undialable: 2,
    withPhone: 110,
    withEmail: 96,
    matched: 7,
    duplicatesInFile: 1,
    unreachable: 0,
    matches: [],
    ...over,
  };
}

describe("pct", () => {
  it("is a whole percentage, and zero rather than NaN when nothing has happened", () => {
    expect(pct(34, 120)).toBe(28);
    expect(pct(0, 0)).toBe(0);
    expect(pct(5, 0)).toBe(0);
    expect(pct(120, 120)).toBe(100);
  });

  it("never goes past 100 or below 0", () => {
    expect(pct(200, 120)).toBe(100);
    expect(pct(-5, 120)).toBe(0);
  });
});

describe("rowTitle / rowNumber", () => {
  it("names a row by company, then contact, then whatever number the file had", () => {
    expect(rowTitle(row())).toBe("BrightPath Dental");
    expect(rowTitle(row({ company: null }))).toBe("Devon Okafor");
    expect(rowTitle(row({ company: null, contactName: null }))).toBe("(239) 555-7015");
    expect(rowTitle(row({ company: null, contactName: null, phoneRaw: null }))).toBe("—");
  });

  it("prefers the dialable number but falls back to the file's text", () => {
    expect(rowNumber(row())).toBe("+12395557015");
    expect(rowNumber(row({ phoneE164: null }))).toBe("(239) 555-7015");
    expect(rowNumber(row({ phoneE164: null, phoneRaw: null }))).toBeNull();
  });
});

describe("dispositionKind", () => {
  it("makes interest a win and a refusal a loss", () => {
    expect(dispositionKind("Interested")).toBe("won");
    expect(dispositionKind("Not interested")).toBe("lost");
    expect(dispositionKind("Wrong number")).toBe("lost");
    expect(dispositionKind("Callback scheduled")).toBe("warn");
    expect(dispositionKind("Voicemail")).toBe("open");
    expect(dispositionKind(null)).toBeUndefined();
  });
});

describe("matchLabel", () => {
  it("names the key in the operator's words", () => {
    expect(matchLabel(row({ matchedBy: "phone" }))).toBe("Phone");
    expect(matchLabel(row({ matchedBy: "account_name" }))).toBe("Company name");
    expect(matchLabel(row({ matchedBy: "in_file" }))).toBe("Duplicate in this file");
    expect(matchLabel(row())).toBeNull();
  });
});

describe("canConvert / isDialable", () => {
  it("offers Convert once, and never on a skipped row", () => {
    expect(canConvert(row())).toBe(true);
    expect(canConvert(row({ leadId: "1051" }))).toBe(false);
    expect(canConvert(row({ status: "skipped" }))).toBe(false);
  });

  it("only calls a ready row with a number", () => {
    expect(isDialable(row())).toBe(true);
    expect(isDialable(row({ phoneE164: null }))).toBe(false);
    expect(isDialable(row({ status: "staged" }))).toBe(false);
  });
});

describe("callbackDue", () => {
  const now = new Date("2027-01-08T16:00:00Z");
  it("is due once the promised time has passed, and never without one", () => {
    expect(callbackDue(row({ callbackAt: "2027-01-08T15:00:00.000Z" }), now)).toBe(true);
    expect(callbackDue(row({ callbackAt: "2027-01-09T15:00:00.000Z" }), now)).toBe(false);
    expect(callbackDue(row(), now)).toBe(false);
    expect(callbackDue(row({ callbackAt: "nonsense" }), now)).toBe(false);
  });
});

describe("statsLine", () => {
  it("is the prototype's sub-line, word for word", () => {
    expect(
      statsLine({
        rows: 120,
        skipped: 0,
        called: 34,
        interested: 6,
        converted: 3,
        booked: 1,
        linked: 7,
        dialable: 118,
        callbacksDue: 0,
      }),
    ).toBe("120 rows · 34 called · 6 interested · 1 booked");
  });
});

describe("listMeta", () => {
  const list = (over: Partial<ColdListView> = {}): ColdListView => ({
    id: "7",
    name: "Chamber",
    status: "ready",
    centre: "HPFM",
    ownerRepId: "3",
    ownerRepSlug: "kelsea",
    ownerRepName: "Kelsea Kosco",
    ownerRepInitials: "KK",
    sourceFilename: "chamber.csv",
    columnMap: null,
    parseMeta: null,
    headers: [],
    rowCount: 120,
    importedBy: "kelsea@headpinz.com",
    archivedAt: null,
    createdAt: "2026-08-28T12:00:00.000Z",
    stats: {
      rows: 120,
      skipped: 0,
      called: 34,
      interested: 6,
      converted: 3,
      booked: 1,
      linked: 7,
      dialable: 118,
      callbacksDue: 0,
    },
    ...over,
  });

  it("says the rows, the owner and the file", () => {
    expect(listMeta(list())).toEqual(["120 rows", "Kelsea Kosco", "chamber.csv"]);
  });

  it("says out loud when an import was never finished", () => {
    expect(listMeta(list({ status: "staged" }))).toContain("import not finished");
  });

  it("copes with a list nobody owns", () => {
    expect(listMeta(list({ ownerRepName: null }))).toEqual(["120 rows", "chamber.csv"]);
  });
});

describe("importSummary", () => {
  it("leads with what was read, then what needs a decision", () => {
    const lines = importSummary(report());
    expect(lines[0]).toBe("113 rows read · 110 with a number · 96 with an email");
    expect(lines.some((l) => l.includes("7 rows match"))).toBe(true);
    expect(lines.some((l) => l.includes("linked, not duplicated"))).toBe(true);
    expect(lines.some((l) => l.includes("1 row repeats"))).toBe(true);
    expect(lines.some((l) => l.includes("2 numbers could not be read"))).toBe(true);
  });

  it("says nothing about a category that has nothing in it", () => {
    const lines = importSummary(
      report({ matched: 0, duplicatesInFile: 0, undialable: 0, unreachable: 0 }),
    );
    expect(lines).toHaveLength(1);
  });

  it("tells the operator when rows have no way to be reached at all", () => {
    const lines = importSummary(report({ unreachable: 4 }));
    expect(lines.some((l) => l.includes("4 rows have neither a number nor an email"))).toBe(true);
  });

  it("says 'row' for one and 'rows' for more", () => {
    expect(importSummary(report({ rows: 1 }))[0]).toContain("1 row read");
    expect(importSummary(report({ matched: 1 })).join(" ")).toContain("1 row matches");
  });
});

describe("firstMatchExample / reportIsEmpty", () => {
  it("names the first matched account, as the prototype's banner does", () => {
    expect(
      firstMatchExample(
        report({ matches: [row({ accountName: "BrightPath Dental", matchedBy: "phone" })] }),
      ),
    ).toBe("BrightPath Dental");
    expect(firstMatchExample(report({ matches: [] }))).toBeNull();
  });

  it("falls back to the row's own company when the match had no account name", () => {
    expect(
      firstMatchExample(report({ matches: [row({ accountName: null, matchedBy: "phone" })] })),
    ).toBe("BrightPath Dental");
  });

  it("knows an empty file when it sees one", () => {
    expect(reportIsEmpty(report({ rows: 0 }))).toBe(true);
    expect(reportIsEmpty(report())).toBe(false);
  });
});

describe("isoFromLocal", () => {
  it("turns a datetime-local value into an instant, and refuses nonsense", () => {
    expect(isoFromLocal("2027-01-08T10:00")).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(isoFromLocal("")).toBeNull();
    expect(isoFromLocal("not a date")).toBeNull();
  });
});
