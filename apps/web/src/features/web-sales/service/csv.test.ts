import { describe, expect, it } from "vitest";
import { CSV_COLUMNS, csvCell, csvFilename, csvRow, toCsv } from "./csv";
import { makeSaleRow } from "../test-support";

/**
 * A real RFC 4180 reader, because the output cannot be asserted with
 * `split(",")`: the ET timestamp column is `8/3/2026, 3:18:17 PM`, which is
 * quoted precisely BECAUSE it contains a comma. Splitting naively misaligns
 * every column after it — and a test that reads the file differently from a
 * spreadsheet is testing the wrong thing.
 */
function parseCsv(text: string): string[][] {
  const records: string[][] = [];
  let row: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cur += '"';
          i++;
        } else inQuotes = false;
      } else cur += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(cur);
      cur = "";
    } else if (ch === "\r" && text[i + 1] === "\n") {
      row.push(cur);
      records.push(row);
      row = [];
      cur = "";
      i++;
    } else {
      cur += ch;
    }
  }
  if (cur !== "" || row.length > 0) {
    row.push(cur);
    records.push(row);
  }
  return records;
}

/** The single data record of a one-row export, as a column → value lookup. */
function onlyRecord(csv: string): Record<string, string> {
  const [header, record] = parseCsv(csv);
  return Object.fromEntries(header.map((h, i) => [h, record[i]]));
}

describe("csvCell", () => {
  it("leaves a plain value alone", () => {
    expect(csvCell("Jacob Elliott")).toBe("Jacob Elliott");
    expect(csvCell(36.21)).toBe("36.21");
  });

  it("renders null and undefined as empty, not as the words", () => {
    expect(csvCell(null)).toBe("");
    expect(csvCell(undefined)).toBe("");
  });

  it("quotes commas, quotes and newlines, doubling embedded quotes", () => {
    expect(csvCell("Fort Myers, FL")).toBe('"Fort Myers, FL"');
    expect(csvCell('He said "hi"')).toBe('"He said ""hi"""');
    expect(csvCell("line one\nline two")).toBe('"line one\nline two"');
    expect(csvCell("carriage\rreturn")).toBe('"carriage\rreturn"');
  });

  it("quotes values whose surrounding whitespace a reader would eat", () => {
    expect(csvCell("  padded  ")).toBe('"  padded  "');
  });

  it("neutralises formula injection from guest-supplied text", () => {
    // Buyer names and gift messages land in this file. Without the leading
    // apostrophe these execute when the export is opened.
    expect(csvCell("=1+1")).toBe("'=1+1");
    expect(csvCell("+SUM(A1)")).toBe("'+SUM(A1)");
    expect(csvCell("-2")).toBe("'-2");
    expect(csvCell("@import")).toBe("'@import");
  });

  it("still quotes an injection-prefixed value that also contains a comma", () => {
    expect(csvCell("=A1,B2")).toBe('"\'=A1,B2"');
  });
});

describe("csvRow", () => {
  it("joins cells with commas", () => {
    expect(csvRow(["a", 1, null, "c,d"])).toBe('a,1,,"c,d"');
  });
});

describe("toCsv", () => {
  it("emits the header in the pinned column order", () => {
    const [header] = toCsv([]).split("\r\n");
    expect(header).toBe(CSV_COLUMNS.join(","));
  });

  it("survives a full round-trip of a value containing a comma, a quote and a newline", () => {
    const nasty = 'Smith, "JJ"\nJunior';
    const csv = toCsv([makeSaleRow({ buyer: { ...makeSaleRow().buyer, name: nasty } })]);
    // Read back the way a spreadsheet would: the record must survive intact,
    // embedded newline and all, without spilling into a second row.
    const records = parseCsv(csv);
    expect(records).toHaveLength(2);
    expect(onlyRecord(csv).Buyer).toBe(nasty);
  });

  it("writes money as bare decimals a spreadsheet will sum", () => {
    const record = onlyRecord(toCsv([makeSaleRow()]));
    expect(record.Paid).toBe("36.21");
    expect(record.Paid).not.toContain("$");
  });

  it("leaves money blank rather than writing 0.00 when a source has no subtotal", () => {
    const record = onlyRecord(
      toCsv([makeSaleRow({ money: { paidCents: 2500, subtotalCents: null, taxCents: null } })]),
    );
    expect(record.Paid).toBe("25.00");
    expect(record.Subtotal).toBe("");
    expect(record.Tax).toBe("");
  });

  it("renders a voided sale distinctly from a refunded one", () => {
    const voided = onlyRecord(
      toCsv([
        makeSaleRow({ refund: { kind: "voided", at: "2026-08-03T00:00:00.000Z", reason: "duplicate" } }),
      ]),
    );
    expect(voided.Refund).toBe("voided");
    // A void moved no money — the refunded column must stay empty, not read 0.00.
    expect(voided.Refunded).toBe("");

    const refunded = onlyRecord(
      toCsv([
        makeSaleRow({
          refund: { kind: "full", refundedCents: 3621, at: "2026-08-03T00:00:00.000Z", destination: "card" },
        }),
      ]),
    );
    expect(refunded.Refund).toBe("full → card");
    expect(refunded.Refunded).toBe("36.21");
  });

  it("joins the searchable handles so they can be pasted back into the board", () => {
    const record = onlyRecord(toCsv([makeSaleRow({ searchTerms: ["HPWK8EJPXCR", "batch-1"] })]));
    expect(record.Reference).toBe("HPWK8EJPXCR batch-1");
  });

  it("keeps every column aligned even though the ET timestamp contains a comma", () => {
    const [header, record] = parseCsv(toCsv([makeSaleRow()]));
    expect(header).toEqual([...CSV_COLUMNS]);
    expect(record).toHaveLength(CSV_COLUMNS.length);
  });

  it("terminates the last line", () => {
    expect(toCsv([makeSaleRow()]).endsWith("\r\n")).toBe(true);
  });
});

describe("csvFilename", () => {
  it("names the file after the range it covers", () => {
    expect(csvFilename("2026-07-05", "2026-08-03")).toBe("web-sales-2026-07-05_2026-08-03.csv");
  });
});
