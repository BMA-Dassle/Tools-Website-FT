import { describe, expect, it } from "vitest";
import {
  BOM,
  isBlankRow,
  normaliseHeaders,
  parseCsv,
  previewRows,
  sniffDelimiter,
  splitCsv,
  stripBom,
  syntheticHeaders,
} from "./csv";
import {
  UGLY_CSV,
  UGLY_CSV_SEMICOLON,
  UGLY_HEADERS,
  UGLY_RAGGED_ROWS,
  UGLY_ROW_COUNT,
} from "./test-support";

describe("the ugly fixture", () => {
  const table = parseCsv(UGLY_CSV);

  it("eats the BOM and names every column, disambiguating the duplicate Phone", () => {
    expect(table.meta.hadBom).toBe(true);
    expect(table.headers).toEqual(UGLY_HEADERS);
    // The two Phone columns stay two columns; collapsing them would lose one.
    expect(new Set(table.headers).size).toBe(table.headers.length);
  });

  it("drops the blank row, keeps every other, and reports both counts", () => {
    expect(table.records).toHaveLength(UGLY_ROW_COUNT);
    expect(table.meta.blankRows).toBe(1);
    expect(table.meta.raggedRows).toBe(UGLY_RAGGED_ROWS);
    expect(table.truncated).toBe(false);
  });

  it("keeps a quoted delimiter, a quoted surname-first name and a doubled quote", () => {
    const first = table.records[0]!;
    expect(first.values["Primary Contact"]).toBe("Okafor, Devon");
    expect(first.values.Notes).toBe("Chamber list, tech night");
    const meridian = table.records.find((r) => r.values["Business Name"] === "Meridian IT")!;
    expect(meridian.values.Notes).toBe('Said "call in January"');
  });

  it("keeps a real newline inside a quoted cell", () => {
    const church = table.records.find((r) => r.values["Business Name"] === "Riverside Church")!;
    expect(church.values.Notes).toBe("Line one\nLine two");
  });

  it("trims an unquoted cell but not a quoted one", () => {
    const coastal = table.records.find((r) => r.values["Business Name"] === "Coastal Title Co.")!;
    expect(coastal.values.Email).toBe("RENATA@CoastalTitle.example");
    const church = table.records.find((r) => r.values["Business Name"] === "Riverside Church")!;
    expect(church.values["Business Name"]).toBe("Riverside Church");
  });

  it("numbers rows by their line in the file, so a row can be named to a human", () => {
    expect(table.records[0]!.index).toBe(1);
    expect(table.records.at(-1)!.index).toBe(UGLY_ROW_COUNT);
  });

  it("keeps a short row's cells rather than refusing the row", () => {
    const palm = table.records.find((r) => r.values["Business Name"] === "Palm Legal Group")!;
    expect(palm.values.City).toBe("Naples");
    expect(palm.values.Notes).toBe("No contact name");
    // The seventh column simply is not there; nothing is invented for it.
    expect(palm.values["Phone (2)"]).toBeUndefined();
  });

  it("keeps the second Phone column's value under its own key", () => {
    const first = table.records[0]!;
    expect(first.values.Phone).toBe("(239) 555-7015");
    expect(first.values["Phone (2)"]).toBe("239-555-7016");
  });

  it("reads the same file when it is semicolon-separated", () => {
    const semi = parseCsv(UGLY_CSV_SEMICOLON);
    expect(semi.meta.delimiter).toBe(";");
    expect(semi.headers).toEqual(UGLY_HEADERS);
    expect(semi.records).toHaveLength(UGLY_ROW_COUNT);
  });
});

describe("stripBom", () => {
  it("removes a leading BOM and says it did", () => {
    expect(stripBom(BOM + "a,b")).toEqual({ text: "a,b", hadBom: true });
    expect(stripBom("a,b")).toEqual({ text: "a,b", hadBom: false });
  });
});

describe("splitCsv", () => {
  it("handles CRLF, LF and a bare CR in one file", () => {
    expect(splitCsv("a,b\r\nc,d\ne,f\rg,h", ",")).toEqual([
      ["a", "b"],
      ["c", "d"],
      ["e", "f"],
      ["g", "h"],
    ]);
  });

  it("treats a quote inside an unquoted field as text", () => {
    expect(splitCsv('5" pipe,ok', ",")).toEqual([['5" pipe', "ok"]]);
  });

  it("keeps an empty trailing cell", () => {
    expect(splitCsv("a,b,", ",")).toEqual([["a", "b", ""]]);
  });

  it("returns one row for a file with no trailing newline", () => {
    expect(splitCsv("a,b", ",")).toEqual([["a", "b"]]);
  });

  it("does not invent a row for a file that ends in a newline", () => {
    expect(splitCsv("a,b\r\n", ",")).toEqual([["a", "b"]]);
  });
});

describe("isBlankRow", () => {
  it("is true for a row of empty and whitespace cells", () => {
    expect(isBlankRow([""])).toBe(true);
    expect(isBlankRow(["", "   ", ""])).toBe(true);
    expect(isBlankRow(["", "x"])).toBe(false);
  });
});

describe("sniffDelimiter", () => {
  it("prefers the delimiter that gives a consistent width", () => {
    expect(sniffDelimiter("a,b,c\r\nd,e,f")).toBe(",");
    expect(sniffDelimiter("a;b;c\r\nd;e;f")).toBe(";");
    expect(sniffDelimiter("a\tb\tc\r\nd\te\tf")).toBe("\t");
    expect(sniffDelimiter("a|b|c\r\nd|e|f")).toBe("|");
  });

  it("is not fooled by a comma inside a semicolon file's quoted cell", () => {
    expect(sniffDelimiter('name;notes\r\nLee;"a, b, c, d"')).toBe(";");
  });

  it("falls back to a comma when nothing splits", () => {
    expect(sniffDelimiter("onecolumn\r\nvalue")).toBe(",");
  });
});

describe("normaliseHeaders", () => {
  it("names a blank header by its position and numbers repeats", () => {
    expect(normaliseHeaders(["Name", "", "Name", " Name "])).toEqual([
      "Name",
      "Column 2",
      "Name (2)",
      "Name (3)",
    ]);
  });

  it("strips a BOM that survived on the first header", () => {
    expect(normaliseHeaders([BOM + "Company"])).toEqual(["Company"]);
  });
});

describe("a file with no header row", () => {
  const table = parseCsv("BrightPath Dental,(239) 555-7015\r\nCoastal Title,(239) 555-3110", {
    hasHeaderRow: false,
  });

  it("synthesises column names and keeps the first line as data", () => {
    expect(table.headers).toEqual(["Column 1", "Column 2"]);
    expect(table.records).toHaveLength(2);
    expect(table.records[0]!.values["Column 1"]).toBe("BrightPath Dental");
  });

  it("syntheticHeaders is the same list", () => {
    expect(syntheticHeaders(2)).toEqual(["Column 1", "Column 2"]);
  });
});

describe("limits", () => {
  it("stops at maxRows and says so rather than silently truncating", () => {
    const csv = ["a", "1", "2", "3", "4"].join("\r\n");
    const table = parseCsv(csv, { maxRows: 2 });
    expect(table.records).toHaveLength(2);
    expect(table.truncated).toBe(true);
  });

  it("previewRows takes the head of the file", () => {
    const table = parseCsv(UGLY_CSV);
    expect(previewRows(table, 3)).toHaveLength(3);
    expect(previewRows(table, 3)[0]).toBe(table.records[0]);
  });
});

describe("an empty file", () => {
  it("parses to nothing without throwing", () => {
    const table = parseCsv("");
    expect(table.headers).toEqual([]);
    expect(table.records).toEqual([]);
    expect(table.meta.bytes).toBe(0);
  });
});
