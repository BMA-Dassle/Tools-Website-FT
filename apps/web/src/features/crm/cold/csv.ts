/**
 * A CSV reader for whatever the sales team was actually sent.
 *
 * WHY THIS EXISTS RATHER THAN A LIBRARY: the file is a chamber-of-commerce
 * export, a LinkedIn download or somebody's spreadsheet "saved as CSV", and
 * the owner has not told us which columns any of them have (decision D9 is
 * open, brief §5.8). So nothing here assumes a schema, a column order, or even
 * a header row — it turns bytes into a table, names the columns it found, and
 * hands the naming decision to the operator (`mapping.ts`).
 *
 * What it survives, because real files do all of it:
 *   - a UTF-8 BOM in front of the first header (Excel writes one);
 *   - CRLF, LF and bare-CR line endings, mixed in one file;
 *   - quoted fields containing the delimiter, a newline, or a doubled `""`;
 *   - semicolons, tabs or pipes instead of commas (European Excel, exports);
 *   - blank rows anywhere, including a trailing one;
 *   - ragged rows — fewer or more cells than the header;
 *   - blank and duplicate header cells.
 *
 * PURE AND CLIENT-SAFE. The browser parses the file with this module to show
 * the mapping screen, and the server re-reads the stored raw records with the
 * same code. No Node, no Neon, no imports beyond the sub's own contracts.
 */

import { COLD_MAX_ROWS, type ColdParseMeta } from "./contracts";

export const CSV_DELIMITERS = [",", ";", "\t", "|"] as const;
export type CsvDelimiter = (typeof CSV_DELIMITERS)[number];

export const BOM = "﻿";

/** One record: its 1-based line number in the file and its cells by header. */
export interface CsvRecord {
  index: number;
  values: Record<string, string>;
}

export interface CsvTable {
  /** Disambiguated, never empty, in file order. */
  headers: string[];
  records: CsvRecord[];
  meta: ColdParseMeta;
  /** True when `maxRows` cut the file short. */
  truncated: boolean;
}

export interface CsvParseOptions {
  /** Force a delimiter instead of sniffing one. */
  delimiter?: string;
  /** False = the first line is data; headers become "Column 1", "Column 2"… */
  hasHeaderRow?: boolean;
  maxRows?: number;
}

/** Strip a leading BOM. Returns the text and whether one was there. */
export function stripBom(text: string): { text: string; hadBom: boolean } {
  if (text.startsWith(BOM)) return { text: text.slice(BOM.length), hadBom: true };
  return { text, hadBom: false };
}

/**
 * The tokenizer. RFC 4180 plus the tolerances above: a quote that opens a
 * field is honoured to its close, a quote in the middle of an unquoted field is
 * literal text (spreadsheets emit that), and a `""` inside a quoted field is
 * one quote.
 */
export function splitCsv(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let cellWasQuoted = false;
  let started = false;

  const pushCell = () => {
    row.push(cellWasQuoted ? cell : cell.trim());
    cell = "";
    cellWasQuoted = false;
  };
  const pushRow = () => {
    pushCell();
    rows.push(row);
    row = [];
    started = false;
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;

    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }

    if (ch === '"' && cell === "") {
      quoted = true;
      cellWasQuoted = true;
      started = true;
      continue;
    }
    if (ch === delimiter) {
      pushCell();
      started = true;
      continue;
    }
    if (ch === "\n" || ch === "\r") {
      // Swallow the \n of a \r\n pair.
      if (ch === "\r" && text[i + 1] === "\n") i++;
      pushRow();
      continue;
    }
    cell += ch;
    started = true;
  }

  // A file that does not end in a newline still has a last row.
  if (started || cell !== "" || row.length > 0) pushRow();
  return rows;
}

/** Every cell empty once trimmed. */
export function isBlankRow(cells: readonly string[]): boolean {
  return cells.every((c) => c.trim() === "");
}

/**
 * Which delimiter the file uses. Each candidate is scored by how many rows
 * agree on a column count greater than one; ties break in `CSV_DELIMITERS`
 * order, so an ordinary comma file is never mistaken for a pipe file.
 */
export function sniffDelimiter(text: string, sampleChars = 64_000): CsvDelimiter {
  const sample = text.slice(0, sampleChars);
  let best: CsvDelimiter = ",";
  let bestScore = -1;
  for (const d of CSV_DELIMITERS) {
    const rows = splitCsv(sample, d)
      .filter((r) => !isBlankRow(r))
      .slice(0, 40);
    if (rows.length === 0) continue;
    const counts = new Map<number, number>();
    for (const r of rows) counts.set(r.length, (counts.get(r.length) ?? 0) + 1);
    let width = 1;
    let agree = 0;
    for (const [w, n] of counts) {
      if (w > 1 && (n > agree || (n === agree && w > width))) {
        width = w;
        agree = n;
      }
    }
    // Reward agreement first, then width: a two-column file beats a one-column
    // read, and a consistent five-column file beats a ragged nine-column one.
    const score = agree === 0 ? 0 : agree * 100 + width;
    if (score > bestScore) {
      bestScore = score;
      best = d;
    }
  }
  return best;
}

/**
 * Name the columns. A blank header becomes `Column N`; a repeat becomes
 * `Name (2)`. Both happen in real exports and both would otherwise collapse
 * two different columns into one key in the stored record.
 */
export function normaliseHeaders(cells: readonly string[]): string[] {
  const seen = new Map<string, number>();
  return cells.map((raw, i) => {
    const base = raw.replace(BOM, "").trim() || `Column ${i + 1}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n === 1 ? base : `${base} (${n})`;
  });
}

/** `Column 1 … Column n` for a file whose first line is already data. */
export function syntheticHeaders(width: number): string[] {
  return Array.from({ length: width }, (_, i) => `Column ${i + 1}`);
}

/**
 * Read a whole file into a table.
 *
 * A ragged row keeps everything it has: extra cells land under
 * `Column <n>` keys beyond the header, and missing ones are simply absent from
 * the record rather than being filled with "". The count of ragged rows is
 * reported so the operator can be told rather than silently losing a column.
 */
export function parseCsv(input: string, opts: CsvParseOptions = {}): CsvTable {
  const { text, hadBom } = stripBom(input);
  const bytes = input.length;
  const delimiter = opts.delimiter ?? sniffDelimiter(text);
  const hasHeaderRow = opts.hasHeaderRow ?? true;
  const maxRows = opts.maxRows ?? COLD_MAX_ROWS;

  const all = splitCsv(text, delimiter);
  let blankRows = 0;
  const kept: string[][] = [];
  for (const r of all) {
    if (isBlankRow(r)) {
      blankRows++;
      continue;
    }
    kept.push(r);
  }

  const headerCells = hasHeaderRow ? (kept.shift() ?? []) : [];
  const width = hasHeaderRow ? headerCells.length : kept.reduce((w, r) => Math.max(w, r.length), 0);
  const headers = hasHeaderRow ? normaliseHeaders(headerCells) : syntheticHeaders(width);

  const truncated = kept.length > maxRows;
  const body = truncated ? kept.slice(0, maxRows) : kept;

  let raggedRows = 0;
  const records: CsvRecord[] = body.map((cells, i) => {
    if (cells.length !== headers.length) raggedRows++;
    const values: Record<string, string> = {};
    for (let c = 0; c < cells.length; c++) {
      const key = headers[c] ?? `Column ${c + 1}`;
      const v = cells[c] ?? "";
      if (v !== "") values[key] = v;
    }
    return { index: i + 1, values };
  });

  return {
    headers,
    records,
    truncated,
    meta: { delimiter, hadBom, hasHeaderRow, blankRows, raggedRows, bytes },
  };
}

/**
 * The first few records, for the mapping screen's preview. Kept here so the
 * screen has no parsing logic of its own.
 */
export function previewRows(table: CsvTable, n = 5): CsvRecord[] {
  return table.records.slice(0, n);
}
