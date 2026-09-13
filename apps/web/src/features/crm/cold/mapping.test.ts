import { describe, expect, it } from "vitest";
import { canonicalizePhone } from "@/lib/participant-contact";
import { parseCsv } from "./csv";
import {
  coldBmiPersonId,
  coldEmailKey,
  coldPhone,
  headerKey,
  isUndialable,
  isUnreachable,
  previewProjection,
  projectRecord,
  rowLabel,
  scoreHeader,
  splitPersonName,
  suggestColumnMap,
  unmappedHeaders,
} from "./mapping";
import { UGLY_CSV, UGLY_HEADERS } from "./test-support";

describe("suggestColumnMap on the ugly fixture", () => {
  const map = suggestColumnMap(UGLY_HEADERS);

  it("guesses the obvious columns from real-world header spellings", () => {
    expect(map.company).toBe("Business Name");
    expect(map.contactName).toBe("Primary Contact");
    expect(map.phone).toBe("Phone");
    expect(map.email).toBe("Email");
    expect(map.city).toBe("City");
    expect(map.notes).toBe("Notes");
  });

  it("never puts one column in two fields", () => {
    const used = Object.values(map).filter(Boolean);
    expect(new Set(used).size).toBe(used.length);
  });

  it("leaves the second Phone column alone rather than guessing at it", () => {
    expect(unmappedHeaders(UGLY_HEADERS, map)).toEqual(["Phone (2)"]);
  });
});

describe("suggestColumnMap in general", () => {
  it("maps a split name and then drops the joined one", () => {
    const map = suggestColumnMap(["First Name", "Last Name", "Name", "Company"]);
    expect(map.firstName).toBe("First Name");
    expect(map.lastName).toBe("Last Name");
    expect(map.contactName).toBeUndefined();
  });

  it("prefers an exact alias over a header that merely contains one", () => {
    const map = suggestColumnMap(["Phone Type", "Phone"]);
    expect(map.phone).toBe("Phone");
  });

  it("does not read 'Business Name' as the contact just because it says name", () => {
    const map = suggestColumnMap(["Business Name", "Contact Name"]);
    expect(map.company).toBe("Business Name");
    expect(map.contactName).toBe("Contact Name");
  });

  it("maps nothing at all when nothing matches, instead of guessing", () => {
    expect(suggestColumnMap(["Column 1", "Column 2", "Column 3"])).toEqual({});
  });

  it("copes with a file whose headers are all upper case with underscores", () => {
    const map = suggestColumnMap(["COMPANY_NAME", "WORK_PHONE", "EMAIL_ADDRESS", "TOWN"]);
    expect(map.company).toBe("COMPANY_NAME");
    expect(map.phone).toBe("WORK_PHONE");
    expect(map.email).toBe("EMAIL_ADDRESS");
    expect(map.city).toBe("TOWN");
  });
});

describe("headerKey / scoreHeader", () => {
  it("squashes punctuation and case", () => {
    expect(headerKey("E-mail Address")).toBe("emailaddress");
    expect(headerKey("  Phone #  ")).toBe("phone");
  });

  it("scores exact above prefix/suffix above contains above nothing", () => {
    const exact = scoreHeader("phone", "Phone");
    const edge = scoreHeader("phone", "Phone Number");
    const inside = scoreHeader("phone", "Best Phone To Try");
    expect(exact).toBeGreaterThan(edge);
    expect(edge).toBeGreaterThan(inside);
    expect(scoreHeader("phone", "Revenue")).toBe(0);
  });
});

describe("coldPhone", () => {
  it("agrees with canonicalizePhone, which is what createLead uses", () => {
    for (const raw of ["(239) 555-7015", "239.555.3110", "2395552060", "+1 239 555 8817"]) {
      expect(coldPhone(raw)).toBe(canonicalizePhone(raw));
      expect(coldPhone(raw)).toMatch(/^\+1\d{10}$/);
    }
  });

  it("keeps a number that carries an extension, which canonicalizePhone alone would reject", () => {
    expect(canonicalizePhone("+1 (239) 555-4471 x12")).toBeNull();
    expect(coldPhone("+1 (239) 555-4471 x12")).toBe("+12395554471");
    expect(coldPhone("239-555-4471 ext. 900")).toBe("+12395554471");
    expect(coldPhone("2395554471 #7")).toBe("+12395554471");
  });

  it("refuses a number Excel turned into scientific notation rather than inventing one", () => {
    expect(coldPhone("2.39556E+09")).toBeNull();
  });

  it("refuses a short number, an empty cell and a word", () => {
    expect(coldPhone("555-1234")).toBeNull();
    expect(coldPhone("")).toBeNull();
    expect(coldPhone(null)).toBeNull();
    expect(coldPhone("call the office")).toBeNull();
  });
});

describe("coldEmailKey", () => {
  it("lowercases and trims, and refuses something with no @", () => {
    expect(coldEmailKey("  RENATA@CoastalTitle.example ")).toBe("renata@coastaltitle.example");
    expect(coldEmailKey("not an email")).toBeNull();
    expect(coldEmailKey(null)).toBeNull();
  });
});

describe("coldBmiPersonId", () => {
  it("keeps a 17-digit id as a STRING, exactly", () => {
    // The literal is a string on purpose: `63000000009561437` as a NUMBER is
    // already rounded before any code runs (CLAUDE.md BMI id precision).
    expect(coldBmiPersonId("63000000009561437")).toBe("63000000009561437");
    expect(String(Number("63000000009561437"))).not.toBe("63000000009561437");
  });

  it("discards anything that is not digits rather than coercing it", () => {
    expect(coldBmiPersonId("6.3e16")).toBeNull();
    expect(coldBmiPersonId("P-1042")).toBeNull();
    expect(coldBmiPersonId("")).toBeNull();
  });
});

describe("splitPersonName", () => {
  it("splits on the first space", () => {
    expect(splitPersonName("Renata Silva")).toEqual({ firstName: "Renata", lastName: "Silva" });
    expect(splitPersonName("Paul Van Der Berg")).toEqual({
      firstName: "Paul",
      lastName: "Van Der Berg",
    });
  });

  it("un-inverts 'Last, First'", () => {
    expect(splitPersonName("Okafor, Devon")).toEqual({ firstName: "Devon", lastName: "Okafor" });
  });

  it("gives a single token as the first name and nothing as the surname", () => {
    expect(splitPersonName("Hale")).toEqual({ firstName: "Hale", lastName: "" });
    expect(splitPersonName(null)).toEqual({ firstName: "", lastName: "" });
  });
});

describe("projectRecord over the ugly fixture", () => {
  const table = parseCsv(UGLY_CSV);
  const map = suggestColumnMap(table.headers);
  const by = (company: string) =>
    projectRecord(table.records.find((r) => r.values["Business Name"] === company)!.values, map);

  it("reads the first row end to end", () => {
    const p = by("BrightPath Dental");
    expect(p.company).toBe("BrightPath Dental");
    expect(p.contactName).toBe("Okafor, Devon");
    expect(p.phoneRaw).toBe("(239) 555-7015");
    expect(p.phoneE164).toBe("+12395557015");
    expect(p.emailKey).toBe("devon@brightpath.example");
    expect(p.city).toBe("Fort Myers");
    expect(p.bmiPersonId).toBeNull();
  });

  it("keeps the raw phone when it cannot be dialled, and flags it", () => {
    const p = by("Broken Phone Co");
    expect(p.phoneRaw).toBe("2.39556E+09");
    expect(p.phoneE164).toBeNull();
    expect(isUndialable(p)).toBe(true);
    // It still has an email, so it is not unreachable.
    expect(isUnreachable(p)).toBe(false);
  });

  it("reads a row with no contact name and no email", () => {
    const p = by("Palm Legal Group");
    expect(p.contactName).toBeNull();
    expect(p.email).toBeNull();
    expect(p.phoneE164).toBe("+12395552060");
    expect(isUnreachable(p)).toBe(false);
  });

  it("reads the extension number as dialable", () => {
    expect(by("Meridian IT").phoneE164).toBe("+12395554471");
  });

  it("joins a split name when both halves are mapped", () => {
    const p = projectRecord(
      { First: "Devon", Last: "Okafor", Whole: "ignored" },
      { firstName: "First", lastName: "Last", contactName: "Whole" },
    );
    expect(p.contactName).toBe("Devon Okafor");
  });

  it("falls back to the whole-name column when the halves are empty", () => {
    const p = projectRecord(
      { First: "", Last: "", Whole: "Dr. Hale" },
      { firstName: "First", lastName: "Last", contactName: "Whole" },
    );
    expect(p.contactName).toBe("Dr. Hale");
  });

  it("is all-null for an empty map, and the row is then unreachable", () => {
    const p = projectRecord(table.records[0]!.values, {});
    expect(p.company).toBeNull();
    expect(p.phoneE164).toBeNull();
    expect(isUnreachable(p)).toBe(true);
  });

  it("a re-map moves a column without touching the stored record", () => {
    const record = table.records[0]!.values;
    const first = projectRecord(record, { phone: "Phone" });
    const second = projectRecord(record, { phone: "Phone (2)" });
    expect(first.phoneE164).toBe("+12395557015");
    expect(second.phoneE164).toBe("+12395557016");
    expect(record.Phone).toBe("(239) 555-7015");
  });
});

describe("rowLabel", () => {
  it("names a row by company, then contact, then number", () => {
    expect(rowLabel({ company: "Lee Health", contactName: "X", phoneRaw: "1" })).toBe("Lee Health");
    expect(rowLabel({ company: null, contactName: "Dr. Hale", phoneRaw: "1" })).toBe("Dr. Hale");
    expect(rowLabel({ company: null, contactName: null, phoneRaw: "(239) 555-1" })).toBe(
      "(239) 555-1",
    );
    expect(rowLabel({ company: null, contactName: null, phoneRaw: null })).toBe("—");
  });
});

describe("previewProjection", () => {
  it("pairs the first records with what the map makes of them", () => {
    const table = parseCsv(UGLY_CSV);
    const rows = previewProjection(table, suggestColumnMap(table.headers), 2);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.record).toBe(table.records[0]);
    expect(rows[0]!.projection.company).toBe("BrightPath Dental");
  });
});
